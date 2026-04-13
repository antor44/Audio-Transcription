#!/usr/bin/env python3
# run_server.py — WhisperLive server launcher and compatibility wrapper
# Version: 1.6
#
# Copyright (C) 2026 Antonio Ruiz
#
# This file is part of Audio Transcription.
#
# This file is based in part on the upstream run_server.py example from
# collabora/WhisperLive, licensed under the MIT License.
#
# Upstream copyright notice:
# Copyright (c) 2023 Vineet Suryan, Collabora Ltd.
#
# Audio Transcription is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Audio Transcription is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with Audio Transcription. If not, see <https://www.gnu.org/licenses/>.
#
# Additional third-party licensing information, including the preserved MIT
# notice for upstream WhisperLive-derived material, is provided in
# THIRD_PARTY_NOTICES.md.

import argparse
import inspect
import logging
import os
import signal
import sys

# =============================================================================
# Colored / categorized logging
# =============================================================================

_R    = "\033[0m"
_BOLD = "\033[1m"

_C_SERVER = "\033[96m"   # bright cyan   — startup / config
_C_CONN   = "\033[94m"   # bright blue   — client connect / disconnect
_C_AUDIO  = "\033[92m"   # bright green  — audio processing
_C_WARN   = "\033[93m"   # bright yellow — warnings
_C_ERR    = "\033[91m"   # bright red    — real errors
_C_MUTED  = "\033[90m"   # dark grey     — low-priority noise
_C_DISCO  = "\033[35m"   # magenta       — expected disconnect pseudo-errors

_PFX_SERVER = "🚀 "
_PFX_CONN   = "🔌 "
_PFX_AUDIO  = "🎙  "
_PFX_WARN   = "⚠  "
_PFX_ERR    = "✖  "
_PFX_MUTED  = "·  "
_PFX_DISCO  = "↩  "

_DISCONNECT_PHRASES = (
    "1000 (ok)", "1001 (going away)",
    "client disconnected", "received 1000", "sent 1000",
)


def _is_normal_disconnect(record: logging.LogRecord) -> bool:
    return any(p in record.getMessage().lower() for p in _DISCONNECT_PHRASES)


def _categorize(record: logging.LogRecord):
    name  = record.name.lower()
    level = record.levelno

    if level >= logging.ERROR:
        if _is_normal_disconnect(record):
            return _C_DISCO, _PFX_DISCO
        return _C_ERR, _PFX_ERR

    if level >= logging.WARNING:
        return _C_WARN, _PFX_WARN

    if name == "__main__":
        return _C_SERVER, _PFX_SERVER

    if "faster_whisper" in name:
        return _C_AUDIO, _PFX_AUDIO

    if "websockets" in name:
        return _C_MUTED, _PFX_MUTED

    msg = record.getMessage().lower()
    conn_keywords = (
        "client connected", "connection closed", "new client",
        "cleaning up", "exiting speech", "connection open",
        "using device", "running faster", "running tensorrt",
        "running openvino", "single model",
    )
    if any(kw in msg for kw in conn_keywords):
        return _C_CONN, _PFX_CONN

    return _C_AUDIO, _PFX_AUDIO


class ColorFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        color, prefix = _categorize(record)
        bold = _BOLD if record.levelno >= logging.WARNING else ""

        record.message = record.getMessage()
        if record.exc_info and not record.exc_text:
            record.exc_text = self.formatException(record.exc_info)

        if record.levelno >= logging.ERROR and _is_normal_disconnect(record):
            label = "INFO    "
        else:
            label = f"{record.levelname:<8}"

        line = (
            f"{color}{prefix}{bold}{label}{_R}"
            f"  {color}{record.message}{_R}"
        )
        if record.exc_text:
            line += f"\n{_C_ERR}{record.exc_text}{_R}"
        return line


def _setup_logging() -> None:
    fmt = ColorFormatter()
    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(fmt)
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    logging.getLogger("websockets").setLevel(logging.WARNING)


_setup_logging()
logger = logging.getLogger(__name__)


# =============================================================================
# Signal handler
# =============================================================================

def signal_handler(sig, frame):
    logger.info("Received interrupt signal. Shutting down gracefully…")
    os._exit(0)


# =============================================================================
# Runtime kwargs filtering
# =============================================================================

def filter_kwargs_for(func, kwargs: dict) -> tuple[dict, list[str]]:
    """
    Return (accepted_kwargs, rejected_keys).
    If the function has **kwargs, everything is accepted.
    """
    try:
        sig = inspect.signature(func)
    except (ValueError, TypeError):
        return kwargs, []

    has_var_keyword = any(
        p.kind == inspect.Parameter.VAR_KEYWORD
        for p in sig.parameters.values()
    )
    if has_var_keyword:
        return kwargs, []

    accepted = {k: v for k, v in kwargs.items() if k in sig.parameters}
    rejected = [k for k in kwargs if k not in sig.parameters]
    return accepted, rejected


# =============================================================================
# Monkey patching — inject beam_size into faster-whisper transcription
#
# WhisperLive does not expose beam_size as a configurable parameter.
# We patch ServeClientFasterWhisper.transcribe_audio at import time so that
# every call to the faster-whisper backend uses the beam_size chosen by the
# user via --beam-size, without modifying any installed package files.
#
# The patch is applied only when backend=faster_whisper (default).
# TensorRT beam_width is set at engine compile time, not at runtime.
# =============================================================================

def apply_beam_size_patch(beam_size: int) -> bool:
    """
    Patch ServeClientFasterWhisper.transcribe_audio to inject beam_size.
    Returns True if the patch was applied successfully, False otherwise.
    """
    try:
        from whisper_live.backend.faster_whisper_backend import (
            ServeClientFasterWhisper,
        )
    except ImportError as exc:
        logger.warning("Could not import ServeClientFasterWhisper: %s", exc)
        return False

    original_transcribe = ServeClientFasterWhisper.transcribe_audio

    def patched_transcribe_audio(self, input_sample):
        """
        Replacement for transcribe_audio that injects beam_size.
        Falls back to the original method if anything goes wrong.
        """
        if ServeClientFasterWhisper.SINGLE_MODEL:
            ServeClientFasterWhisper.SINGLE_MODEL_LOCK.acquire()
        try:
            result, info = self.transcriber.transcribe(
                input_sample,
                initial_prompt=self.initial_prompt,
                language=self.language,
                task=self.task,
                vad_filter=self.use_vad,
                vad_parameters=self.vad_parameters if self.use_vad else None,
                beam_size=beam_size,
            )
        except TypeError:
            # If transcribe() does not accept beam_size (older faster-whisper),
            # fall back to the original unpatched call silently.
            logger.warning(
                "beam_size parameter not accepted by this faster-whisper "
                "version — using default beam size."
            )
            ServeClientFasterWhisper.transcribe_audio = original_transcribe
            result, info = original_transcribe(self, input_sample)
            return result
        finally:
            if ServeClientFasterWhisper.SINGLE_MODEL:
                ServeClientFasterWhisper.SINGLE_MODEL_LOCK.release()

        if self.language is None and info is not None:
            self.set_language(info)
        return result

    ServeClientFasterWhisper.transcribe_audio = patched_transcribe_audio
    return True


# =============================================================================
# CUDA detection helper
# =============================================================================

def _detect_cuda() -> bool:
    """Return True if a usable CUDA device is actually available."""
    if os.environ.get("CUDA_VISIBLE_DEVICES") == "":
        return False
    # ctranslate2 is always present when faster-whisper is installed
    try:
        import ctranslate2
        types = ctranslate2.get_supported_compute_types("cuda")
        return bool(types)
    except Exception:
        pass
    # Fallback: torch (may not be installed)
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        pass
    return False


# =============================================================================
# Main
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Start a local WebSocket transcription server (WhisperLive)."
    )

    # -- Network --------------------------------------------------------------
    parser.add_argument(
        "--host", type=str, default="127.0.0.1",
        help="Host address to bind (default: 127.0.0.1). "
             "Use 0.0.0.0 for LAN / remote access.",
    )
    parser.add_argument(
        "--port", "-p", type=int, default=9090,
        help="WebSocket port (default: 9090).",
    )

    # -- Backend --------------------------------------------------------------
    parser.add_argument(
        "--backend", "-b", type=str, default="faster_whisper",
        choices=["faster_whisper", "tensorrt", "openvino"],
        help="Transcription backend (default: faster_whisper).",
    )

    # -- Device ---------------------------------------------------------------
    parser.add_argument(
        "--device", type=str, default="auto",
        choices=["auto", "cpu", "cuda"],
        help="Device for faster-whisper backend (default: auto). Use 'cpu' to force CPU mode.",
    )

    # -- Model paths ----------------------------------------------------------
    parser.add_argument(
        "--faster_whisper_custom_model_path", "-fw",
        type=str, default=None,
        help="Path to a custom Faster Whisper / OpenVINO model (optional).",
    )
    parser.add_argument(
        "--trt_model_path", "-trt",
        type=str, default=None,
        help="Path to a Whisper TensorRT model (required when backend=tensorrt).",
    )
    parser.add_argument(
        "--trt_multilingual", "-m", action="store_true",
        help="Enable multilingual support for TensorRT (default: False).",
    )
    parser.add_argument(
        "--trt_py_session", action="store_true",
        help="TensorRT only: use Python session instead of C++ session.",
    )
    parser.add_argument(
        "--cache_path", "-c", type=str, default="~/.cache/whisper-live/",
        help="Directory for cached ctranslate2 models.",
    )

    # -- Performance ----------------------------------------------------------
    parser.add_argument(
        "--omp_num_threads", "-omp", type=int, default=1,
        help="OpenMP threads for CPU inference (default: 1).",
    )
    parser.add_argument(
        "--no_single_model", "-nsm", action="store_true",
        help="Each client gets its own model instance instead of sharing one.",
    )

    # -- Connection limits ----------------------------------------------------
    parser.add_argument(
        "--max_clients", type=int, default=100,
        help="Max simultaneous clients (default: 100).",
    )
    parser.add_argument(
        "--max_connection_time", type=int, default=7 * 24 * 60 * 60,
        help="Max connection time per client in seconds (default: 604800 = 7 days).",
    )

    # -- REST API -------------------------------------------------------------
    parser.add_argument("--rest_port", type=int, default=8000,
                        help="Port for the optional REST API (default: 8000).")
    parser.add_argument("--enable_rest", action="store_true",
                        help="Enable the OpenAI-compatible REST API endpoint.")
    parser.add_argument("--cors_origins", type=str, default=None,
                        help="Comma-separated CORS origins for the REST API.")

    # -- Batch GPU inference --------------------------------------------------
    parser.add_argument("--batch_inference", action="store_true",
                        help="Enable batched GPU inference.")
    parser.add_argument("--batch_max_size", type=int, default=8,
                        help="Max batch size (default: 8).")
    parser.add_argument("--batch_window_ms", type=int, default=50,
                        help="Max ms to wait for batch to fill (default: 50).")

    # -- Beam size (faster-whisper only) --------------------------------------
    parser.add_argument(
        "--beam-size", "--beam_size",
        type=int, default=2,
        dest="beam_size",
        help="Beam size for faster-whisper decoding (default: 2). "
             "1 = greedy (fastest, good for live streaming). "
             "2 = best balance for live streaming (recommended). "
             "5 = OpenAI default (most accurate, more lag). "
             "Has no effect when backend=tensorrt (set at engine compile time).",
    )

    args = parser.parse_args()

    # -- Validation -----------------------------------------------------------
    if args.backend == "tensorrt" and args.trt_model_path is None:
        parser.error(
            "--trt_model_path is required when using the tensorrt backend."
        )

    if "OMP_NUM_THREADS" not in os.environ:
        os.environ["OMP_NUM_THREADS"] = str(args.omp_num_threads)

    # -- Apply beam_size patch before importing the server --------------------
    # Only patch faster_whisper backend — TensorRT beam width is fixed at
    # engine compile time and cannot be changed at runtime.
    if args.backend == "faster_whisper":
        if args.beam_size != 5:
            # 5 is the faster-whisper default — no need to patch if unchanged
            patched = apply_beam_size_patch(args.beam_size)
            if patched:
                logger.info(
                    "faster-whisper beam_size set to %d %s",
                    args.beam_size,
                    "(greedy)" if args.beam_size == 1
                    else "(recommended for live streaming)" if args.beam_size == 2
                    else "",
                )
        else:
            logger.info(
                "faster-whisper beam_size: 5 (faster-whisper default)"
            )
    elif args.backend == "tensorrt":
        logger.info(
            "TensorRT backend: beam_width is fixed at engine compile time, "
            "--beam-size has no effect."
        )

    # -- Import server --------------------------------------------------------
    try:
        from whisper_live.server import TranscriptionServer
    except ImportError as exc:
        logger.error("Could not import whisper_live — %s", exc)
        sys.exit(1)

    server = TranscriptionServer()

    if args.backend == "faster_whisper":
        if args.device == "cpu" or os.environ.get("CUDA_VISIBLE_DEVICES") == "":
            _effective_device = "cpu"
        elif args.device == "cuda":
            _effective_device = "cuda"
        else:  # auto
            _effective_device = "cuda" if _detect_cuda() else "cpu"

        if _effective_device == "cuda":
            logger.info("Using Device=cuda with precision float16")
        else:
            logger.info("Using Device=cpu with precision int8")

    logger.info(
        "Server ready → host=%s  port=%d  backend=%s  "
        "max_clients=%d  max_connection_time=%d s",
        args.host, args.port, args.backend,
        args.max_clients, args.max_connection_time,
    )

    signal.signal(signal.SIGINT, signal_handler)

    # -- Build kwargs for server.run() ----------------------------------------
    # In WhisperLive 0.8.0+, server.run() accepts max_clients and
    # max_connection_time directly and creates ClientManager internally.
    # Older versions that lack these params will have them filtered out
    # by filter_kwargs_for(), which inspects the actual function signature.
    all_kwargs = dict(
        host=args.host,
        port=args.port,
        backend=args.backend,
        device=args.device,
        faster_whisper_custom_model_path=args.faster_whisper_custom_model_path,
        whisper_tensorrt_path=args.trt_model_path,
        trt_multilingual=args.trt_multilingual,
        trt_py_session=args.trt_py_session,
        single_model=not args.no_single_model,
        max_clients=args.max_clients,
        max_connection_time=args.max_connection_time,
        cache_path=args.cache_path,
        rest_port=args.rest_port,
        enable_rest=args.enable_rest,
        cors_origins=args.cors_origins,
        batch_enabled=args.batch_inference,
        batch_max_size=args.batch_max_size,
        batch_window_ms=args.batch_window_ms,
    )
    all_kwargs = {k: v for k, v in all_kwargs.items() if v is not None}

    accepted_kwargs, rejected_keys = filter_kwargs_for(server.run, all_kwargs)

    # For older WhisperLive versions that don't accept max_clients /
    # max_connection_time in server.run(), fall back to setting ClientManager
    # directly on the server object before run() is called.
    missing_limits = [k for k in ("max_clients", "max_connection_time")
                      if k in rejected_keys]
    if missing_limits:
        try:
            from whisper_live.server import ClientManager
            server.client_manager = ClientManager(
                args.max_clients, args.max_connection_time
            )
            logger.info(
                "ClientManager fallback → max_clients=%d  max_connection_time=%d s",
                args.max_clients, args.max_connection_time,
            )
        except (ImportError, TypeError, AttributeError) as exc:
            logger.warning(
                "Could not set connection limits via ClientManager: %s", exc
            )

    # Warn only about parameters that are truly unsupported (not limits,
    # which are handled above via fallback)
    truly_ignored = [k for k in rejected_keys
                     if k not in ("max_clients", "max_connection_time", "device")]
    if truly_ignored:
        logger.warning(
            "The following parameters are not supported by the installed "
            "WhisperLive version and will have no effect: %s.",
            ", ".join(truly_ignored),
        )

    server.run(**accepted_kwargs)


if __name__ == "__main__":
    main()
