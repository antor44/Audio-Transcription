# Audio Transcription for Chrome/Chromium/Microsoft Edge (v2.8.0)

## Using the Extension

### 1. Prepare the Server
Ensure that your local [WhisperLive](https://github.com/collabora/WhisperLive) server is running. (See installation instructions below).

### 2. Play Audio
Play any audio or video on a webpage.

### 3. Open the Extension
Click the extension icon in your browser toolbar to open the options popup.

### 4. Configure Your Options
The UI is divided into several sections to give you full control over transcription and translation:

#### General Settings
- **Speech (TTS) Speed & Enable TTS:** Enable Text-to-Speech to have the extension read the text aloud in real-time. If translation is active, it reads the translated text; otherwise, it reads the original Whisper transcription. You can also adjust the reading speed.

> [!NOTE]
> **How TTS works on different OS:** This feature uses the `chrome.tts` extension API.
> - **Windows:** Uses the voices installed via SAPI 5 (configured in your OS).
> - **macOS:** Uses the native macOS speech voices.
> - **Linux:** 
>   - *Google Chrome* bundles its own internal eSpeak-NG engine (fixed quality, limited languages).
>   - *Microsoft Edge* uses Microsoft's online Neural TTS voices (high quality, broad language support, requires internet).
>   - *Chromium* has no built-in engine. It will only work if a TTS engine extension (like Piper) is installed; otherwise, no audio will be produced.

- **Show in Standalone Window:** Choose between displaying the text in a floating overlay inside the webpage, or in a dedicated, resizable standalone popup window.
- **Voice Activity Detection (VAD):** Enable this to stop processing audio during silent periods, saving CPU/GPU resources.

#### WhisperLive Server
- Enter a custom server IP address and port to connect to your transcription server (default is `localhost` and `9090`).
- Click **Reset Default** to revert the IP address and port to local settings (`localhost:9090`). Other settings will be preserved.

#### Transcription Settings
- **Audio Language:** Select the source language of the audio, or leave it on "Auto Detect".
  *Tip: If you select a language different from the one spoken in the audio, larger Whisper models (like large-v2 or large-v3) will often provide a very good direct translation into the selected language natively, without needing external translation features.*
- **Whisper Task:** Choose between "Transcribe" (text in the original language) or "Translate" (direct Whisper translation to English).
- **Model Size:** Pick the model size that suits your system’s hardware (from Base to Large-v3).
- **Text Formatting:** Choose from "Raw Segments", "Joined Text", or "Advanced Paragraphs" to make the output more readable.
- **Transcription Profile:** Choose between three performance profiles that control how quickly text is stabilized, committed, and sent for translation/TTS:
  - *Accurate:* Conservative mode with more lag. Waits for more context before committing text, producing cleaner and more complete sentences. Recommended for high-quality transcriptions where latency is not critical.
  - *Balanced:* The default behavior. A middle ground between speed and accuracy.
  - *Low Lag:* Aggressive mode that commits text as fast as possible. Text appears and stabilizes quickly, and translations/TTS trigger sooner. Best for real-time scenarios where minimal delay is prioritized over perfect sentence structure.
- **Hide Live Text:** When enabled, the unstable live preview text (shown in gray/italics) is hidden. Only stable, committed text (white) and translations are displayed. Useful if the constantly changing preview text is distracting.

*(All transcription profile and live text changes take effect in real-time — no need to restart the capture).*

#### Gemini & Google Translation
- **Enable Translation:** Check this to activate real-time translation.
- **Gemini API Key:** If you intend to use a Gemini model, paste your Google Gemini API key here (you can get one for free from Google AI Studio).
- **Translation Model (Free Option Available):** Select your desired engine. You can choose **Google Translate** for completely free translations without an API key, or select a Gemini model (e.g., `gemini-2.5-flash`).
- **Automatic Fallback:** If you select a Gemini model and the API fails, times out, or throws an error, the extension will automatically use the free Google Translate as a fallback. Translations produced by this fallback are marked with a `⁺` (U+207A) symbol at the beginning of the text.
- **Target Language:** Select the language you want to translate the text into.
- **Display Mode:** Choose how to view the text ("Original Only", "Translation Only", or "Side by Side").

> [!IMPORTANT]
> **Note on Gemini Models & Pricing:**
> While models like the `gemini-flash-lite` family offer generous free tiers, advanced models like `gemini-pro` are typically available only through the paid tier of the Gemini API (pay-per-use). Please check your billing status if you plan to use Pro models or expect intensive usage. Under normal usage, the cost is typically no more than a few cents per day.

**Model Recommendations for High-Quality Translation or Correction:**
*   The **Free Tier** works reliably only for Flash models and is recommended when both source and destination languages are major ones.
*   For reliable subtitles or long sessions, use a **Paid Tier** (at least Flash-Lite or Flash), which provides excellent results for major languages and improves same-language transcription.
*   Use **Pro models** when dealing with minority languages, though you might experience more translation failures due to longer processing times.

### 5. Start Transcription
Click **Start Capture** to begin capturing audio and sending it to the server. The first time a model is selected, the necessary files will be downloaded automatically. You can monitor active settings and connection status in the real-time status bar at the top of the transcription window.

### 6. Window Customization & History
The transcription windows (both in-page overlay and standalone) give you full control:
- Freely move and resize the windows to fit your layout.
- Increase or decrease the text font size.
- All processed text is saved in a continuous history. You can easily copy the entire transcript (both original and translated) to your clipboard with a single click.

### 7. Stop Transcription
Click **Stop Capture** to end the session.

---

## Installing the WhisperLive Server

Depending on your operating system, you may need to create a Python virtual environment using either Anaconda or `virtualenv`. You must activate this environment to run the WhisperLive server.

**For Ubuntu/Debian:**
```sh
sudo apt install virtualenv
```
**For macOS:**
```sh
brew install virtualenv
```

**Set up the environment:**
```sh
mkdir ~/python-environments
virtualenv ~/python-environments/whisper-live
source ~/python-environments/whisper-live/bin/activate
```

**Install WhisperLive (at least version 0.6.3):**
```sh
pip3 install whisper-live
```
*(Alternatively, you can install it manually by cloning the [WhisperLive GitHub repository](https://github.com/collabora/WhisperLive) and running `pip3 install .`)*.

**Download this extension repository:**
```sh
git clone https://github.com/antor44/Audio-Transcription.git
```

## Running the WhisperLive Server

Before using the extension, ensure the local WhisperLive server is running.

```sh
cd Audio-Transcription-Chrome
```

Run the server script (which optionally accepts arguments):
```sh
./WhisperLive_server.sh
```

Or, if using a Python virtual environment:
```sh
source ~/python-environments/whisper-live/bin/activate && ./WhisperLive_server.sh
```

*(If a "numpy version 2" error occurs, run: `pip3 install "numpy<2"`)*

> [!TIP]
> You can edit the **`WhisperLive_server.sh`** bash script to automatically add the environment activation command. Just add `source ~/python-environments/whisper-live/bin/activate` at the beginning, right below `#!/bin/bash`.

## Installing the Extension in your Browser

1. Open Google Chrome, Chromium, or Microsoft Edge.
2. In the address bar, type `chrome://extensions` and press Enter.
3. Enable **Developer mode** (toggle switch in the top right corner). 
4. Click the **Load unpacked** button.
5. Browse to the folder where you cloned this repository and select the `Audio-Transcription-Chrome` folder.
6. The extension should now appear on your extensions page.

## Windows Installation (WSL2)

For Windows users, the local server runs through Windows Subsystem for Linux (WSL2):

1. Install PortAudio inside WSL2:
   ```sh
   sudo apt-get install portaudio19-dev python3-all-dev
   ```
2. Install WhisperLive and run `./WhisperLive_server.sh` within your Linux environment.
3. Use the extension in the Windows version of Chrome/Edge by downloading this repository to a normal Windows folder and loading it via the **Load unpacked** option.

---

## Screenshots

*(Make sure to update these links with your new repository URL)*

![Screenshot 1](https://github.com/antor44/Audio-Transcription/raw/main/Chrome_extension1.jpg)

![Screenshot 2](https://github.com/antor44/Audio-Transcription/raw/main/Chrome_extension2.jpg)

![Screenshot 3](https://github.com/antor44/Audio-Transcription/raw/main/Chrome_extension3.jpg)

---

## FAQ

**Q: What is a localhost server? Can I use the extension over the internet to connect to my server?**
A: A localhost server runs directly on your own PC. The Chrome extension uses a local port to communicate with this server, which transcribes the audio. The server can even transcribe multiple audio streams from different web browsers on your PC simultaneously.
By default, this local interface is not accessible from outside your computer. However, you can configure the server and the extension to connect from different PCs on your LAN. Connecting via the Internet is also possible, though it requires specific port-forwarding and network settings on your router.

**Q: Are connections to the server secure? Is it safe to use over the Internet?**
A: The WhisperLive server uses WebSockets without SSL/TLS, meaning both audio clips and transcribed texts are transmitted unencrypted. This is perfectly safe for a local server (`localhost`) or a trusted LAN. If you need to access it over the Internet securely, you should connect via SSH tunnels or set up a reverse proxy (like Nginx) with SSL.

**Q: Can the server run with GPU acceleration?**
A: Yes! WhisperLive Server supports the `faster-whisper` backend, which is automatically GPU-accelerated as long as your system has compatible Nvidia CUDA libraries installed. It also supports the highly efficient **TensorRT backend** for Nvidia cards. 
Keep in mind that while WhisperLive handles concurrent clients, VRAM is the main bottleneck. You can configure the server in single-model mode to optimize VRAM, ensuring all clients share the same model size. Load balancing across multiple GPUs requires an external solution.

**Q: How do I set up WhisperLive with TensorRT acceleration using Docker?**

Docker is the recommended (and easiest) way to run the TensorRT backend. It bundles the exact versions of CUDA, TensorRT-LLM, and all dependencies.

#### Step 1 — Prerequisites
- NVIDIA GPU with CUDA support (tested on RTX 30xx/40xx)
- [Docker](https://docs.docker.com/get-docker/) and [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) installed.
- **~10–12 GB free disk space** during compilation.

Add your user to the `docker` group:
```bash
sudo usermod -aG docker $USER
newgrp docker
```
Verify your setup:
```bash
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

#### Step 2 — Download the Whisper model weights
```bash
mkdir -p ~/whisper-engines
wget -O ~/whisper-engines/large-v2.pt https://openaipublic.azureedge.net/main/whisper/models/81f7c96c852ee8fc832187b0132e569d6c3065a3252ed18e56effd0b6a73e524/large-v2.pt
```

#### Step 3 — Compile the TensorRT engines
Engines are GPU-specific and must be compiled once. Start a temporary build container:
```bash
docker run -it --gpus all -v ~/whisper-engines:/engines ghcr.io/collabora/whisperlive-tensorrt:latest bash
```
Inside the container, run:
```bash
cd /app/TensorRT-LLM-examples/whisper
mkdir -p assets
ln -sf /engines/large-v2.pt assets/large-v2.pt
mkdir -p /engines/tmp && export TMPDIR=/engines/tmp

# Convert checkpoint
python3 convert_checkpoint.py --output_dir /engines/large-v2-weights --model_name large-v2

# Compile encoder
mkdir -p /engines/large-v2/encoder
trtllm-build --checkpoint_dir /engines/large-v2-weights/encoder --output_dir /engines/large-v2/encoder --moe_plugin disable --enable_xqa disable --max_batch_size 1 --gemm_plugin disable --bert_attention_plugin float16 --max_input_len 3000 --max_seq_len 3000

# Compile decoder (max_beam_width=1 is crucial to avoid CUDA errors)
mkdir -p /engines/large-v2/decoder
trtllm-build --checkpoint_dir /engines/large-v2-weights/decoder --output_dir /engines/large-v2/decoder --moe_plugin disable --enable_xqa disable --max_beam_width 1 --max_batch_size 1 --max_seq_len 200 --max_input_len 14 --max_encoder_input_len 3000 --gemm_plugin float16 --bert_attention_plugin float16 --gpt_attention_plugin float16

exit
```
*(Optional: Delete `large-v2.pt` and the weights folder afterward to save space).*

#### Step 4 — Start the server
```bash
./WhisperLive_server.sh docker trt --model large-v2 --multilingual
```

---

**Q: What quality of transcription can I expect on a low-end processor?**
A: Since WhisperLive utilizes the highly optimized `faster-whisper`, performance is excellent even on older CPUs (like 10-year-old Intel Haswell chips). For English, using `base.en` or `small.en` models provides fantastic real-time transcription with minimal CPU usage. However, minority languages or heavy translation tasks require larger models, which demand a better CPU or a dedicated GPU.

**Q: Why do transcribed words sometimes change, disappear, or look unstable?**
A: The extension displays the real-time incremental output generated by the WhisperLive server. To achieve low latency, the server transcribes audio chunks quickly and then continuously re-evaluates them as more audio context arrives. This causes the most recent words (the "live preview") to change or jump around until the sentence is finalized.

Because Whisper was originally designed for batch processing rather than real-time streaming, the intermediate text blocks lack deterministic timestamps, making them inherently unstable. 

**Current and planned solutions:**
1. **Transcription Profiles:** We have implemented the *Accurate/Balanced/Low Lag* profiles to let you control the delay. "Accurate" mode adds a slight look-ahead delay to stabilize context before showing the text.
2. **Text Formatting:** By applying basic heuristic rules (like intelligent line breaks and punctuation), we mitigate the visual jumping effect. 
3. **Future Updates:** We are working on lightweight client-side post-processing to better anchor segments without increasing computational overhead.
4. 
