#!/usr/bin/env python3
"""
Build the reference tokenizer table that ai-gateway/src/modelprobe-refs.js ships.

The probe text and sizes are constants, so every reference token count and ID
sequence is a compile-time value: the gateway runtime needs no tokenizer at all.
Run this whenever PROBE_TEXT or the family list changes:

    python3 scripts/build-modelprobe-refs.py > ai-gateway/src/modelprobe-refs.js

Requirements: tiktoken. Optional and better: `tokenizers` plus network access to
HuggingFace, which adds the open-weights families that share a byte-level BPE
with GPT-2 and are therefore indistinguishable from it by count alone.
"""
import json
import sys

try:
    import tiktoken
except ImportError:
    sys.exit("tiktoken is required: pip install tiktoken")

# The probe text. Deliberately mixes ASCII prose, code, emoji and CJK so the
# families diverge: CJK splits very differently per vocabulary, and emoji hit
# multi-byte paths that BPE variants handle differently.
PROBE_TEXT = (
    "def fib(n):\n"
    "    return n if n < 2 else fib(n-1) + fib(n-2)\n"
    "# The 快速 brown 🐱 jumps over the 懒惰 dog and 13 tokens éàü.\n"
    "x = [i**2 for i in range(10)]  # 0x1F 0b101 3.14159\n"
    "你好世界，这是一个用于区分分词器的句子。こんにちは世界。"
    "Die schnelle Katze springt über den faulen Hund. 🦊🚀🧪\n"
    "SELECT id, COUNT(*) FROM events WHERE ts > now() - interval '1 day' GROUP BY id;"
)
# Sizes multiplied for the slope measurement (reference: those used by modelprobe).
SLOPE_SIZES = [1, 2, 3, 4, 5]
# Short string for the raw token-ID fingerprint.
FINGERPRINT_STRINGS = [
    "Hello world! The quick brown fox 🦊 writes Python: x = [1,2,3] 你好",
    PROBE_TEXT,
]
# Every prompt the probe sends, so reference token counts exist for all of them.
PROMPT_STRINGS = {
    "ping": "ping",
    "identity": ("Answer strictly as: MODEL=<your exact model name>; "
                 "CUTOFF=<your training data cutoff date>. Nothing else."),
    "determinism": "List exactly 5 prime numbers above 100, comma separated.",
    "routing": "Reply with one word: ok",
}

# tiktoken families: encoding name -> (family key, human label).
TIKTOKEN_FAMILIES = {
    "o200k_base": ("o200k", "OpenAI GPT-4o/4.1/5.x (o200k)"),
    "cl100k_base": ("cl100k", "OpenAI GPT-3.5/4 (cl100k)"),
    "p50k_base": ("p50k", "OpenAI code/Edit (p50k)"),
    "r50k_base": ("r50k", "OpenAI GPT-3 (r50k)"),
    "gpt2": ("gpt2", "GPT-2 byte-BPE class (many open weights)"),
}

# Open-weights families worth distinguishing, when `tokenizers` and network
# access are available. Stealth resellers usually serve GLM-5 / Kimi / MiniMax
# / Qwen behind a frontier name. Gemini has no public tokenizer; Gemma is gated
# so it is omitted rather than guessed from an unofficial copy.
HF_FAMILIES = {
    "qwen": ("Qwen/Qwen2.5-0.5B", "Qwen 2.5/3"),
    "glm": ("zai-org/GLM-5", "Zhipu GLM-5"),
    "deepseek": ("deepseek-ai/DeepSeek-V3", "DeepSeek V3/R1"),
    "llama": ("NousResearch/Llama-3.2-1B", "Meta Llama 3.x"),
    "mistral": ("mistralai/Mistral-7B-v0.3", "Mistral 7B"),
    # tokenizer.json is not on main; converted file lives on this commit.
    "kimi": ("moonshotai/Kimi-K2.6", "Moonshot Kimi K2.6", "https://huggingface.co/moonshotai/Kimi-K2.6/resolve/37f90fe3c9e87348816d678f04bbd8e25a7e3f68/tokenizer.json"),
    "minimax": ("MiniMaxAI/MiniMax-Text-01", "MiniMax"),
}


def build_tiktoken():
    families = []
    for enc_name, (key, label) in TIKTOKEN_FAMILIES.items():
        enc = tiktoken.get_encoding(enc_name)
        families.append({
            "key": key,
            "label": label,
            "source": "tiktoken:" + enc_name,
            "slopes": {str(k): len(enc.encode(PROBE_TEXT * k)) for k in SLOPE_SIZES},
            "counts": {name: len(enc.encode(text)) for name, text in PROMPT_STRINGS.items()},
            "fingerprints": [enc.encode(text) for text in FINGERPRINT_STRINGS],
        })
    return families


def build_hf():
    try:
        from tokenizers import Tokenizer
    except ImportError:
        print("[build] tokenizers not installed; shipping tiktoken families only", file=sys.stderr)
        return []
    import urllib.request
    families = []
    for key, spec in HF_FAMILIES.items():
        repo, label = spec[0], spec[1]
        pinned = spec[2] if len(spec) > 2 else None
        tok = None
        err = None
        if pinned:
            try:
                with urllib.request.urlopen(pinned, timeout=60) as resp:
                    tok = Tokenizer.from_buffer(resp.read())
                print(f"[build] {label} loaded from pinned {pinned}", file=sys.stderr)
            except Exception as e:
                print(f"[build] {label} pinned tokenizer unavailable: {e}", file=sys.stderr)
                continue
        else:
            try:
                tok = Tokenizer.from_pretrained(repo)
            except Exception as e:
                err = e
                url = "https://huggingface.co/" + repo + "/resolve/main/tokenizer.json"
                try:
                    with urllib.request.urlopen(url, timeout=60) as resp:
                        tok = Tokenizer.from_buffer(resp.read())
                    print(f"[build] {label} loaded from {url}", file=sys.stderr)
                except Exception as e2:
                    print(f"[build] {label} ({repo}) unavailable: {err}; json fallback: {e2}", file=sys.stderr)
                    continue
        families.append({
            "key": key,
            "label": label + f" [{repo}]",
            "source": "hf:" + repo,
            "slopes": {str(k): len(tok.encode(PROBE_TEXT * k).ids) for k in SLOPE_SIZES},
            "counts": {name: len(tok.encode(text).ids) for name, text in PROMPT_STRINGS.items()},
            "fingerprints": [tok.encode(text).ids for text in FINGERPRINT_STRINGS],
        })
        print(f"[build] added {label} from {repo}", file=sys.stderr)
    return families


def main():
    families = build_tiktoken() + build_hf()
    payload = {
        "probe_text": PROBE_TEXT,
        "slope_sizes": SLOPE_SIZES,
        "fingerprint_strings": FINGERPRINT_STRINGS,
        "prompts": PROMPT_STRINGS,
        "families": families,
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    print("// Generated by scripts/build-modelprobe-refs.py — do not edit by hand.")
    print("//")
    print("// Reference tokenizer data for the model-integrity probes. Every value is a")
    print("// constant because the probe text and sizes are constants, which is why the")
    print("// gateway can run these probes with no tokenizer runtime and no npm packages.")
    print("//")
    print("// Regenerate after editing PROBE_TEXT or the family lists:")
    print("//   python3 scripts/build-modelprobe-refs.py > ai-gateway/src/modelprobe-refs.js")
    print()
    print("export const MODELPROBE_REFS = " + body + ";")
    print()
    print("export default MODELPROBE_REFS;")


if __name__ == "__main__":
    main()
