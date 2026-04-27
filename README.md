# signalk-rtsp-plugin

A [Signal K](https://signalk.org) plugin that streams an RTSP camera feed to the Signal K web UI via fragmented MP4 (fmp4) over HTTP.

It relies on [signalk-container](https://github.com/dirkwa/signalk-container) to spin up an FFmpeg container that handles the RTSP → fmp4 conversion. No disk I/O, no HLS segments, no native dependencies — just a live HTTP stream piped straight to the browser's native MediaSource API.

## Features

- **Live video in the Signal K UI** — native fmp4 player accessible at `/plugins/signalk-rtsp-plugin/player`, listed as a webapp in the Signal K dashboard
- **RTSP authentication** — Basic and Digest (credentials in the stream URL)
- **Zero-config networking** — signalk-container automatically handles the network topology between Signal K and the FFmpeg container (user-defined Docker network, host network, or bare-metal)
- **No disk I/O** — FFmpeg streams directly over HTTP; no HLS segments, no shared volumes
- **No native dependencies** — uses the global `fetch()` and `Buffer` available in Node.js ≥ 18; no `require()` calls
- **Multi-client** — the plugin fans out the fmp4 stream to all connected browsers; late-joining clients receive the init segment so decoding starts immediately
- **Auto-reconnect** — both the plugin-to-FFmpeg connection and the browser player retry automatically on stream loss

## Requirements

- [signalk-container](https://github.com/dirkwa/signalk-container) >= 0.2.1 installed and enabled
- Docker or Podman available on the host
- An RTSP source (IP camera, NVR, etc.)
- Node.js >= 18 (standard with current Signal K releases)

## Installation

Install via the Signal K app store or manually:

```bash
cd ~/.signalk
npm install signalk-rtsp-plugin
```

Then enable the plugin in **Signal K Admin UI → Plugin Config → RTSP Stream Viewer**.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| RTSP Stream URL | `rtsp://user:password@192.168.1.100:554/stream` | Full RTSP URL including credentials if required |
| FFmpeg Docker image | `linuxserver/ffmpeg` | Docker image used for the RTSP → fmp4 conversion |
| FFmpeg Docker image tag | `latest` | Image tag |
| MSE video codec string | `avc1.64001F` | Passed to `MediaSource.addSourceBuffer()`. `avc1.64001F` = H.264 High 3.1, which covers most IP cameras. Adjust if your camera uses a different profile. |

The player is available at `/plugins/signalk-rtsp-plugin/player` once FFmpeg has connected to the RTSP source (usually within a few seconds).

## Docker Compose

A ready-to-use `docker-compose.yml` is included for running Signal K with the plugin pre-mounted:

```bash
git clone https://github.com/macjl/signalk-rtsp-plugin
cd signalk-rtsp-plugin
docker compose up -d
```

Signal K will be available at `http://localhost:3000`. The plugin will appear in the app store and can be enabled from the admin UI.

> [!note]
> The compose file mounts the Docker socket into the Signal K container so that
> signalk-container can manage the FFmpeg sibling container. See the
> [signalk-container README](https://github.com/dirkwa/signalk-container#running-signal-k-in-a-container)
> for the security implications.

## How it works

```
IP camera ──RTSP──▶ FFmpeg container ──fmp4/HTTP──▶ Plugin connectLoop()
                    (http -listen 1)                       │
                                               broadcast() to all clients
                                                           │
                                              Browser MediaSource API player
```

1. On startup the plugin asks signalk-container to run an FFmpeg container.
   `signalkAccessiblePorts` tells signalk-container that Signal K needs to connect back to port 8090 inside that container — the network topology (Docker network, host network, bare-metal) is resolved automatically.
2. FFmpeg reads the RTSP stream over TCP and serves a fragmented MP4 (`-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof`) over an HTTP endpoint (`-listen 1`).
3. The plugin's `connectLoop()` fetches the fmp4 stream with the global `fetch()` and fans it out to all connected browser clients via chunked HTTP responses.
4. The first ISO BMFF boxes (up to the first `moof`) are cached as the *init segment* and sent to any browser that connects after the stream has started, so decoding begins immediately.
5. The embedded player uses the browser-native **MediaSource API** (`addSourceBuffer` in `sequence` mode) — no hls.js or any other JavaScript library required.

## License

MIT
