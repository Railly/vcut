#!/usr/bin/env python3
"""Find audible sound that is not language, and print it as vcut proposals.

    python3 non-speech.py master.mp4 > non-speech.json
    vcut edl build --detect detect.json --semantic non-speech.json ...

A breath, a mic bump, a lip smack: audible, meaningless, and invisible to both of
vcut's instruments. The silence pass hears energy and calls it speech. The
transcript has no word for it, and worse, the model stretches a neighbouring cue
over it, so the noise ends up inside a word's span rather than beside it.

Four energy statistics were tried and all four failed, because each measures a
proxy for non-speech and every proxy is dominated by ordinary variation in
speech:

    sound with no word covering it      the cue stretches over the noise
    gaps between consecutive words      the largest gap in a tight edit is ~170ms
    energy swing inside one word        a word holding a breath swung less than
                                        an ordinary word did
    median level inside one word        ranks unstressed function words first

Periodicity gets closer, since voiced speech has vibrating folds and a breath is
turbulence, but unvoiced consonants are turbulence too: /s/ and /f/ score like
breath and every sibilant becomes a false positive.

What works is a classifier that was taught what speech sounds like. PANNs is a
CNN trained on AudioSet, which has Speech, Breathing, Sniff and Laughter as
labelled classes. The signal is the absence of Speech rather than the presence of
Breathing: on the recording this was built against, breath scored 0.087 for
Breathing, too low to key on, while its Speech score was 0.06 against 0.64 and up
for every span holding words.

This lives outside the CLI on purpose. vcut has no dependencies and a 300MB torch
checkpoint is not one worth taking for a signal a human ear catches for free.
Anything that emits the proposal schema works here; this is the reference.

Setup:
    vcut setup classifier              # fetches the model into ~/.vcut/panns
    pip install panns-inference scipy numpy
"""

import contextlib
import csv
import io
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import scipy.io.wavfile as wav
import scipy.signal as signal
from panns_inference import AudioTagging

# Long enough for the classifier to have something to judge, short enough that one
# breath is not diluted by the speech around it. Half-overlapping so a span landing
# on a boundary is still seen whole by a neighbouring window.
WINDOW_S = 0.64
HOP_S = 0.32

# Speech scored 0.64 and up on every span holding words, and 0.06 and 0.13 on the
# two a listener flagged. The gap is wide, so the threshold sits in the middle of it
# rather than against either edge.
SPEECH_FLOOR = 0.30

# Run against the rendered master, where the silence pass has already removed the
# pauses. On raw footage every pause scores as non-speech, correctly and uselessly.
PANNS_RATE = 32000
SPEECH_LABELS = {"Speech", "Male speech, man speaking", "Female speech, woman speaking",
                 "Narration, monologue", "Conversation"}


def load_audio(path: str) -> tuple[int, np.ndarray]:
    with tempfile.TemporaryDirectory() as work:
        wav_path = os.path.join(work, "audio.wav")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000",
             "-c:a", "pcm_s16le", "-y", wav_path],
            check=True,
        )
        rate, samples = wav.read(wav_path)
    return rate, samples.astype(np.float32) / 32768.0


def speech_scores(rate: int, samples: np.ndarray, tagger, speech_index: list[int]):
    window = int(WINDOW_S * rate)
    hop = int(HOP_S * rate)
    for start in range(0, max(1, len(samples) - window + 1), hop):
        chunk = samples[start:start + window]
        resampled = signal.resample(chunk, int(len(chunk) * PANNS_RATE / rate))
        clipwise, _ = tagger.inference(resampled.astype(np.float32)[None, :])
        yield start * 1000 // rate, float(clipwise[0][speech_index].max())


def merge(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[list[int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().split("\n\n")[1], file=sys.stderr)
        return 2

    home = os.environ.get("VCUT_CLASSIFIER_HOME", os.path.expanduser("~/.vcut/panns"))
    labels_path = os.path.join(home, "class_labels_indices.csv")
    checkpoint = os.path.join(home, "Cnn14_mAP=0.431.pth")
    for path in (labels_path, checkpoint):
        if not os.path.exists(path):
            print(f"missing {path}; run: vcut setup classifier", file=sys.stderr)
            return 1

    labels = [row[2] for row in csv.reader(open(labels_path)) if row[0] != "index"]
    speech_index = [i for i, label in enumerate(labels) if label in SPEECH_LABELS]
    # The tagger prints its own banner to stdout, which would land in the middle of the JSON
    # a caller is piping. Hold the real stream before redirecting: json.dump would otherwise
    # resolve sys.stdout to whatever the context manager left behind.
    out = sys.stdout
    with contextlib.redirect_stdout(io.StringIO()):
        tagger = AudioTagging(checkpoint_path=checkpoint, device="cpu")

    rate, samples = load_audio(sys.argv[1])
    window_ms = int(WINDOW_S * 1000)
    flagged = [
        (at_ms, at_ms + window_ms)
        for at_ms, score in speech_scores(rate, samples, tagger, speech_index)
        if score < SPEECH_FLOOR
    ]

    proposals = [
        {
            "startMs": start,
            "endMs": end,
            "kind": "non-speech",
            "reason": (
                "Audible and not language: an audio classifier scored this below "
                f"{SPEECH_FLOOR} for speech. Listen before approving, since a laugh and "
                "a breath score alike and only one of them should go."
            ),
        }
        for start, end in merge(flagged)
    ]
    json.dump(proposals, out, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
