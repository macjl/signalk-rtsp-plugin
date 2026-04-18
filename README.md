# signalk-rtsp-plugin

A [Signal K](https://signalk.org) plugin that streams an RTSP camera feed to the Signal K web UI via HLS.

It relies on [signalk-container](https://github.com/dirkwa/signalk-container) to spin up an FFmpeg container that handles the RTSP → HLS transcoding, keeping the plugin itself lightweight and free of native dependencies.

## Features

- **Live video in the Signal K UI** — embedded HLS player accessible at `/signalk-rtsp-plugin/`
- **RTSP authentication** — Basic and Digest (credentials in the stream URL)
- **Zero-config volume sharing** — FFmpeg writes directly into the Signal K data volume; no host paths or extra volumes to configure
- **Works everywhere** — bare-metal Signal K, Docker, Podman (rootless or root)
- **Auto-reconnect** — the player retries automatically on stream loss

## Requirements

- [signalk-container](https://github.com/dirkwa/signalk-container) >= 0.2.0 installed and enabled
- Docker or Podman available on the host
- An RTSP source (IP camera, NVR, etc.)

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
| FFmpeg Docker image | `linuxserver/ffmpeg` | Docker image used for transcoding |
| FFmpeg Docker image tag | `latest` | Image tag |

The stream is served at `/signalk-rtsp-plugin/` once FFmpeg has started and produced its first HLS segments (usually within a few seconds).

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
IP camera ──RTSP──▶ FFmpeg container ──HLS──▶ Signal K data volume
                                                      │
                                         Express route /hls/:file
                                                      │
                                               Browser player
```

1. On startup the plugin creates `<dataDir>/rtsp-hls/` inside the Signal K data volume
2. It asks signalk-container to run an FFmpeg container with the Signal K data volume mounted (via `signalkDataMount`) — no host path needed
3. FFmpeg reads the RTSP stream over TCP and writes HLS segments to `<dataDir>/rtsp-hls/`
4. A lightweight Express route serves the segments at `/signalk-rtsp-plugin/hls/:file`
5. The embedded HLS.js player polls the manifest and renders the live feed

## License

MIT
