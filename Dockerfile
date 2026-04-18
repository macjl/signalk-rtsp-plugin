FROM signalk/signalk-server:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends musl && rm -rf /var/lib/apt/lists/*
USER node
