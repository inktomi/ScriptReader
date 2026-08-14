FROM pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install audio processing utilities and git
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    libsndfile1 \
    ffmpeg \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake model weights directly into container layer
COPY download_weights.py .
RUN python download_weights.py

# Copy application server files
COPY engine_kokoro.py .
COPY engine_chatterbox.py .
COPY handler.py .

EXPOSE 8000

CMD ["python", "-u", "handler.py"]
