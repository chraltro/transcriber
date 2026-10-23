"""Rebuilds stretches of a recording with Resemble Enhance (a denoiser plus a latent
flow-matching enhancer trained to turn degraded speech into studio speech).

    python regen.py in.wav out.wav --ranges ranges.json --model <dir with enhancer_stage2>

in.wav is mono float at 44.1 kHz. Outside the ranges the output is the input, sample for sample,
so the page can switch between the two per voice. Progress goes to stdout as JSON lines.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "stubs"))  # DeepSpeed is only needed for training
os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")  # the checkpoint predates torch's safe loading

import numpy as np  # noqa: E402
import scipy.optimize  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402

# resemble-enhance 0.0.1 calls float() on fsolve's 1-element array, which NumPy 2 refuses.
_fsolve = scipy.optimize.fsolve
scipy.optimize.fsolve = lambda *a, **k: _fsolve(*a, **k)[0]

from resemble_enhance.enhancer.inference import enhance  # noqa: E402

RATE = 44100
CHUNK = 10 * RATE  # the model works on short pieces; longer ones need more memory than they're worth
OVERLAP = RATE // 2
PAD = int(0.3 * RATE)  # context either side of each stretch
FADE = int(0.03 * RATE)


def say(**kw):
    print(json.dumps(kw), flush=True)


def rms_loud(x):
    """Level of the speech in x: RMS of its louder half of 50 ms frames."""
    n = len(x) // 2205
    if n < 2:
        return float(np.sqrt(np.mean(x ** 2)) + 1e-9)
    f = np.sqrt(np.mean(x[: n * 2205].reshape(n, 2205) ** 2, axis=1))
    return float(np.mean(np.sort(f)[n // 2 :]) + 1e-9)


def regenerate(seg, run_dir, nfe, on_chunk):
    """seg through the model in overlapping pieces, crossfaded."""
    out = np.zeros(len(seg), np.float64)
    wsum = np.zeros(len(seg), np.float64)
    s = 0
    while s < len(seg):
        e = min(s + CHUNK, len(seg))
        piece = torch.from_numpy(np.ascontiguousarray(seg[s:e], dtype=np.float32))
        y, sr = enhance(piece, RATE, "cpu", nfe=nfe, solver="midpoint", lambd=0.5, tau=0.5, run_dir=run_dir)
        assert sr == RATE
        y = y.numpy()[: e - s]
        if len(y) < e - s:
            y = np.pad(y, (0, e - s - len(y)))
        w = np.ones(e - s)
        if s > 0:
            k = min(OVERLAP, e - s)
            w[:k] = np.linspace(0, 1, k)
        if e < len(seg):
            w[-OVERLAP:] = np.linspace(1, 0, OVERLAP)
        out[s:e] += y * w
        wsum[s:e] += w
        on_chunk(e - s - (OVERLAP if s > 0 else 0))
        if e == len(seg):
            break
        s = e - OVERLAP
    return (out / np.maximum(wsum, 1e-6)).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--ranges", required=True, help="JSON file with [[from, to], ...] in seconds")
    ap.add_argument("--model", required=True, help="directory holding hparams.yaml and ds/")
    ap.add_argument("--nfe", type=int, default=16, help="solver steps: more is slower and a little cleaner")
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 2)
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    from pathlib import Path

    run_dir = Path(args.model)
    x, sr = sf.read(args.input, dtype="float32", always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    if sr != RATE:
        raise SystemExit(f"expected {RATE} Hz, got {sr}")
    with open(args.ranges) as f:
        ranges = json.load(f)
    out = x.copy()
    total = sum(max(0, min(b, len(x) / RATE) - a) for a, b in ranges)
    done = 0.0
    t0 = time.time()
    for a, b in ranges:
        s = max(0, int(a * RATE) - PAD)
        e = min(len(x), int(b * RATE) + PAD)
        if e - s < RATE // 2:
            continue
        seg = x[s:e]

        def on_chunk(n):
            nonlocal done
            done += n / RATE
            el = time.time() - t0
            say(done=round(min(done, total), 1), total=round(total, 1), elapsed=round(el), eta=round(el / max(done, 1e-6) * max(0.0, total - done)))

        y = regenerate(seg, run_dir, args.nfe, on_chunk)
        # Same level as the original stretch: the model normalises its output.
        y *= rms_loud(seg) / rms_loud(y)
        # Into the output with short crossfades at both ends.
        w = np.ones(len(y), np.float32)
        k = min(FADE, len(y) // 4)
        if s > 0:
            w[:k] = np.linspace(0, 1, k)
        if e < len(x):
            w[-k:] = np.linspace(1, 0, k)
        out[s:e] = w * y + (1 - w) * x[s:e]
    peak = float(np.max(np.abs(out))) if len(out) else 0
    if peak > 0.999:
        out *= 0.999 / peak
    sf.write(args.output, out, RATE, subtype="FLOAT")
    say(finished=True, seconds=round(total, 1), elapsed=round(time.time() - t0))


if __name__ == "__main__":
    main()
