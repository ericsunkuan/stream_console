#!/usr/bin/env python
import openai
import base64
import os
import datetime
import wave
import io
import json
import numpy as np
import torch
import soundfile as sf
from torchmetrics.audio import DeepNoiseSuppressionMeanOpinionScore

# =============================
# MOS Evaluation Helper Functions
# =============================

def evaluate_mos_for_audio(pred_audio_path, ref_audio_path):
    """
    Compute the MOS (Mean Opinion Score) for one pair of synthesized (predicted) and reference audio.
    Expects both audio files to have the same sampling rate.
    """
    try:
        # Load the audio files using soundfile.
        pred_audio, sr_pred = sf.read(pred_audio_path)
        ref_audio, sr_ref = sf.read(ref_audio_path)
    except Exception as e:
        print(f"Error reading audio files for {pred_audio_path} / {ref_audio_path}: {e}")
        return None

    if sr_pred != sr_ref:
        print(f"Sampling rate mismatch for files {pred_audio_path} and {ref_audio_path}.")
        return None

    # Convert audio arrays into torch tensors and add a batch dimension.
    # The DeepNoiseSuppressionMeanOpinionScore metric expects input shape [batch, time].
    pred_tensor = torch.tensor(pred_audio).unsqueeze(0)
    ref_tensor = torch.tensor(ref_audio).unsqueeze(0)

    # Initialize the MOS metric.
    mos_metric = DeepNoiseSuppressionMeanOpinionScore()

    # Compute and return the MOS score as a float.
    score = mos_metric(pred_tensor, ref_tensor)
    return score.item()


def evaluate_mos_for_all_speakers(speaker_audio_mapping):
    """
    Evaluate the MOS score for each audio sample per speaker and then average the scores.

    Args:
        speaker_audio_mapping (dict): Mapping of speaker IDs to lists of tuples.
            Each tuple is structured as (pred_audio_path, ref_audio_path).

    Returns:
        dict: Mapping from speaker ID to averaged MOS score.
    """
    speaker_mos_results = {}
    for speaker, audio_pairs in speaker_audio_mapping.items():
        scores = []
        for pred_path, ref_path in audio_pairs:
            score = evaluate_mos_for_audio(pred_path, ref_path)
            if score is not None:
                scores.append(score)
            else:
                print(f"Skipping MOS evaluation for speaker '{speaker}' for audio pair: {pred_path}, {ref_path}")
        avg_score = float(np.mean(scores)) if scores else None
        speaker_mos_results[speaker] = avg_score
    return speaker_mos_results

# =============================
# Original GPT‑4o Conversation and Evaluation Code
# =============================

# *** 0. Setup: API Key and Model config ***
openai.api_key = os.getenv("OPENAI_API_KEY")
# Model names for GPT‑4o and the audio-enabled variant
AUDIO_MODEL = "gpt-4o-audio-preview"  # GPT‑4o model with audio support (preview snapshot)
TEXT_MODEL = "gpt-4o"                 # GPT‑4o can be used for text-only tasks as well

# Voices for the two speakers (choose distinct voices for clarity)
voice_speaker1 = "alloy"  # e.g., Alloy voice for Speaker 1
voice_speaker2 = "echo"   # e.g., Echo voice for Speaker 2

# Create a new folder with a timestamp to save audio files and logs
timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
audio_folder = f"audio_{timestamp}"
os.makedirs(audio_folder, exist_ok=True)
print(f"Audio files and logs will be saved to folder: {audio_folder}\n")

# *** 1. Generate a creative conversation topic using GPT‑4o (text only) ***
topic_prompt_system = "You are a creative assistant who invents conversation topics."
topic_prompt_user = (
    "Generate a creative and expressive conversation topic with clear and specific character settings. "
    "Describe a scenario with two people (Speaker 1 and Speaker 2) in a specific setting, "
    "discussing a topic, with both speakers having an ultimate goal to convince each other or achieve a certain goal. "
    "The two speakers should be competing with each other, and the conversation should be intense and engaging. "
    "For example, it can be two speakers debating whether a single income family should buy a house, "
    "or two speakers negotiating a law proposal. "
    "It should be in about 100 words."
)
response = openai.ChatCompletion.create(
    model=TEXT_MODEL,
    messages=[
        {"role": "system", "content": topic_prompt_system},
        {"role": "user", "content": topic_prompt_user}
    ]
)
topic_narrative = response.choices[0].message.content.strip()
print("=== Conversation Topic Narrative ===")
print(topic_narrative)
print("====================================\n")

# *** 2. Initialize conversation state ***
conversation_audio_history = []   # list to store audio (binary) of each turn
conversation_text_history = []    # list to store text transcript of each turn for reference

# Define personas or style hints for each speaker (optional)
speaker1_persona = None
speaker2_persona = None
# Example:
# speaker1_persona = "Speaker 1 is thoughtful and calm."
# speaker2_persona = "Speaker 2 is energetic and curious."

# *** 3. Simulate a 6-turn dialogue (3 turns per speaker) ***
num_turns = 6
for turn_index in range(1, num_turns + 1):
    current_speaker = 1 if turn_index % 2 == 1 else 2
    # Choose voice for current speaker
    voice = voice_speaker1 if current_speaker == 1 else voice_speaker2

    # Compose the system message with context and role
    role_instruction = f"You are Speaker {current_speaker}."
    if current_speaker == 1 and speaker1_persona:
        role_instruction += " " + speaker1_persona
    if current_speaker == 2 and speaker2_persona:
        role_instruction += " " + speaker2_persona
    role_instruction += " Respond to the conversation in character."
    system_message = (
        f"Conversation Topic:\n{topic_narrative}\n\n"
        f"{role_instruction}"
    )

    # Compose the user message content with optional previous audio context
    user_content_segments = []
    user_content_segments.append({"type": "text", "text": "Speak now. (no more than 30 words)"})
    if conversation_audio_history:
        user_content_segments.append({"type": "text", "text": "Previous conversation audio:"})
        for audio_data in conversation_audio_history:
            user_content_segments.append({
                "type": "input_audio",
                "input_audio": {
                    "data": base64.b64encode(audio_data).decode('utf-8'),
                    "format": "wav"
                }
            })

    # Call the chat completion for this turn
    response = openai.ChatCompletion.create(
        model=AUDIO_MODEL,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_content_segments}
        ],
        modalities=["text", "audio"],
        audio={"voice": voice, "format": "wav"}
    )
    assistant_msg = response.choices[0].message
    if assistant_msg.get("content"):
        text_output = assistant_msg["content"]
    else:
        text_output = assistant_msg["audio"]["transcript"]
    audio_base64 = assistant_msg["audio"]["data"]
    audio_bytes = base64.b64decode(audio_base64)

    # Save transcript and audio output in the conversation state lists
    conversation_text_history.append(f"Speaker {current_speaker}: {text_output}")
    conversation_audio_history.append(audio_bytes)
    
    # Save the individual audio file in the timestamped folder
    filename = os.path.join(audio_folder, f"speaker{current_speaker}_turn{turn_index}.wav")
    with open(filename, "wb") as f:
        f.write(audio_bytes)
    print(f"(Saved audio for Speaker {current_speaker}'s turn {turn_index} to {filename})")
    print(f"Speaker {current_speaker} (turn {turn_index}): {text_output}\n")

print("Dialogue completed. Proceeding to evaluation...\n")

# *** 4. Evaluate the full conversation using GPT‑4o as an evaluator ***
evaluation_system_prompt = (
    "You are an expert speech coach evaluating a conversation between two speakers. "
    "Assess each speaker's performance on the following metrics:\n"
    "1. Rhythm Control (flow and pace of speech)\n"
    "2. Emotional Expression (conveying feeling and tone)\n"
    "3. Pronunciation (clarity and correctness of speech sounds)\n"
    "4. Semantic Clarity and Relevance (clarity of meaning and relevance of response)\n\n"
    "5. Persuasiveness of the argument and the ability to convince the other speaker. "
    "Provide detailed feedback for each speaker on each metric, then give a score out of 10 for each metric for each speaker. "
    "Finally, provide a brief overall impression of each speaker's speaking style. "
    "Format your response clearly, for example:\n\n"
    "Speaker 1 – Rhythm Control: ... (Explanation) ... Score: X/10\n"
    "Speaker 1 – Emotional Expression: ... Score: Y/10\n"
    "... (and so on for Speaker 1, then Speaker 2) ..."
)
evaluation_user_content = []
for idx, audio_bytes in enumerate(conversation_audio_history, start=1):
    spk = 1 if idx % 2 == 1 else 2
    evaluation_user_content.append({"type": "text", "text": f"Speaker {spk}, Turn {idx}:"})
    evaluation_user_content.append({
        "type": "input_audio",
        "input_audio": {
            "data": base64.b64encode(audio_bytes).decode('utf-8'),
            "format": "wav"
        }
    })
    transcript_text = conversation_text_history[idx-1].split(": ", 1)[-1]
    evaluation_user_content.append({"type": "text", "text": f'(Transcript: "{transcript_text}")'})

eval_response = openai.ChatCompletion.create(
    model=AUDIO_MODEL,
    messages=[
        {"role": "system", "content": evaluation_system_prompt},
        {"role": "user", "content": evaluation_user_content}
    ],
)
evaluation_report = eval_response.choices[0].message.content.strip()

print("=== Evaluation Report ===")
print(evaluation_report)

# *** 5. Concatenate all audio files into one "total_conversation.wav" ***
if conversation_audio_history:
    # Get parameters from the first audio file and reset the frame count (nframes) to 0
    first_wav_io = io.BytesIO(conversation_audio_history[0])
    with wave.open(first_wav_io, 'rb') as w:
        params = w.getparams()
    # Reset the number of frames to 0 so that total frames are counted correctly
    params = params._replace(nframes=0)

    total_wav_path = os.path.join(audio_folder, "total_conversation.wav")
    with wave.open(total_wav_path, 'wb') as total_wav:
        total_wav.setparams(params)
        for wav_bytes in conversation_audio_history:
            wav_io = io.BytesIO(wav_bytes)
            with wave.open(wav_io, 'rb') as w:
                frames = w.readframes(w.getnframes())
                total_wav.writeframes(frames)
    print(f"(Saved total concatenated conversation to {total_wav_path})\n")

# *** 6. Create text files with organized conversation details and evaluation report ***
# Conversation details file
details_content = (
    "=== Conversation Details ===\n\n"
    "Topic:\n"
    f"{topic_narrative}\n\n"
    "Speaker Settings:\n"
    f"Speaker 1: {speaker1_persona}\n"
    f"Speaker 2: {speaker2_persona}\n\n"
    "Transcript:\n"
)
for transcript in conversation_text_history:
    details_content += transcript + "\n"

details_file_path = os.path.join(audio_folder, "conversation_details.txt")
with open(details_file_path, "w") as f:
    f.write(details_content)
print(f"(Saved conversation details to {details_file_path})")

# Evaluation report file
evaluation_content = (
    "=== Evaluation Report ===\n\n"
    f"{evaluation_report}\n"
)
evaluation_file_path = os.path.join(audio_folder, "evaluation_report.txt")
with open(evaluation_file_path, "w") as f:
    f.write(evaluation_content)
print(f"(Saved evaluation report to {evaluation_file_path})")

# =============================
# 7. Perform MOS Evaluation and Save Combined Results
# =============================

# Build a mapping from each speaker to the list of (predicted, reference) audio file pairs.
# Here we assume that each synthesized audio turn has a corresponding ground truth audio file
# in a folder called "ground_truth" with a similar naming pattern.
speaker_audio_mapping = {"speaker1": [], "speaker2": []}
for turn_index in range(1, num_turns + 1):
    # Determine speaker based on turn index.
    speaker = "speaker1" if turn_index % 2 == 1 else "speaker2"
    # Predicted audio file is saved in the audio_folder.
    pred_audio_path = os.path.join(audio_folder, f"{speaker}_turn{turn_index}.wav")
    # Reference (ground truth) audio file is assumed to be in the "ground_truth" folder.
    ref_audio_path = os.path.join("ground_truth", f"{speaker}_turn{turn_index}.wav")
    speaker_audio_mapping[speaker].append((pred_audio_path, ref_audio_path))

# Evaluate the MOS scores for each speaker.
mos_results = evaluate_mos_for_all_speakers(speaker_audio_mapping)
print("MOS Evaluation Results:")
for speaker, score in mos_results.items():
    if score is not None:
        print(f"  {speaker}: {score:.3f}")
    else:
        print(f"  {speaker}: No valid MOS score computed")

# If desired, you can combine these MOS scores with other evaluation metrics.
# For this integration, we record the average MOS score per speaker in a JSON output.
combined_evaluation_results = {}
for speaker in speaker_audio_mapping.keys():
    combined_evaluation_results[speaker] = {"mos_score": mos_results.get(speaker, None)}

evaluation_results_file = os.path.join(audio_folder, "evaluation_results.json")
try:
    with open(evaluation_results_file, "w") as f:
        json.dump(combined_evaluation_results, f, indent=4)
    print(f"Combined evaluation results have been saved to {evaluation_results_file}.")
except Exception as e:
    print(f"Error saving evaluation results: {e}")
