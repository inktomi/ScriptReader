FROM pytorch/pytorch:2.13.0-cuda13.0-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PIP_BREAK_SYSTEM_PACKAGES=1

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
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt && \
    pip uninstall -y torchvision || true

# Register all nvidia pip libraries with system dynamic linker
RUN find /usr/local/lib/python3.12/dist-packages/nvidia -type d -name "lib" > /etc/ld.so.conf.d/nvidia-pip.conf && ldconfig

ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/dist-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/dist-packages/nvidia/cudnn/lib:/usr/local/lib/python3.12/dist-packages/nvidia/cuda_runtime/lib:/usr/local/lib/python3.12/dist-packages/nvidia/cufft/lib:/usr/local/lib/python3.12/dist-packages/nvidia/curand/lib:/usr/local/cuda/lib64:$LD_LIBRARY_PATH

# Bake model weights directly into container layer
COPY download_weights.py .
RUN python download_weights.py

# Copy application server files
COPY engine_kokoro.py .
COPY engine_chatterbox.py .
COPY request_contract.py .
COPY handler.py .

EXPOSE 8000

CMD ["python", "-u", "handler.py"]
