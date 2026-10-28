# Node 24 : même version que la CI et que le champ "engines" du package.json.
FROM node:24-slim

# curl / procps (pkill) / jq : outils de base attendus par Claude pour ses
# vérifications (appels HTTP, arrêt d'un serveur local, lecture de JSON).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    curl \
    procps \
    jq \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@2.1.281

# Navigateur headless pour que Claude puisse vérifier visuellement ses
# changements (desktop et mobile) : Playwright + Chromium et ses dépendances
# système, installés dans un dossier partagé lisible par claudeuser.
# NODE_PATH : le script de capture (CommonJS) trouve le Playwright global.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g playwright@1.63.0 \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
COPY seancy-screenshot.cjs /usr/local/bin/seancy-screenshot
RUN chmod 755 /usr/local/bin/seancy-screenshot

RUN useradd -m -s /bin/bash claudeuser

# Clone de travail dédié de Claude (volume nommé monté sur /workspace, qui hérite à sa
# création du propriétaire de ce dossier) et script de lancement des exécutions.
RUN mkdir -p /workspace && chown claudeuser:claudeuser /workspace
COPY seancy-claude-run.sh /usr/local/bin/seancy-claude-run
COPY seancy-claude-dev.sh /usr/local/bin/seancy-claude-dev
RUN chmod 755 /usr/local/bin/seancy-claude-run /usr/local/bin/seancy-claude-dev

RUN (type -p wget >/dev/null || (apt-get update && apt-get install -y wget)) \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg > /tmp/keyring.gpg \
    && install -D -m 644 /tmp/keyring.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
