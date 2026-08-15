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
RUN pip install --no-cache-dir --break-system-packages setuptools wheel numpy cython uv uv-build && \
    pip install --no-cache-dir --break-system-packages --no-build-isolation -r requirements.txt && \
    pip uninstall -y torchvision || true

# Register all nvidia pip libraries with system dynamic linker
RUN find /usr/local/lib/python3.12/dist-packages/nvidia -type d -name "lib" > /etc/ld.so.conf.d/nvidia-pip.conf && ldconfig

ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/dist-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/dist-packages/nvidia/cudnn/lib:/usr/local/lib/python3.12/dist-packages/nvidia/cuda_runtime/lib:/usr/local/lib/python3.12/dist-packages/nvidia/cufft/lib:/usr/local/lib/python3.12/dist-packages/nvidia/curand/lib:/usr/local/cuda/lib64:$LD_LIBRARY_PATH

# Bake model weights directly into container layer
COPY download_weights.py .
RUN python download_weights.py

# Everything the worker reads is in the image now. Reaching the hub at run time
# would only add a revision check to the cold-start path — and a failing one on
# a worker that cannot get out.
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV TRANSFORMERS_ATTN_IMPLEMENTATION=eager

# This worker exists to use a GPU. It refuses to start on CPU rather than bill
# at GPU rates for inference running orders of magnitude slower. Override only
# for a deliberate local CPU run.
ENV SCRIPTREADER_REQUIRE_GPU=1

# Copy application server files
COPY engine_kokoro.py .
COPY engine_chatterbox.py .
COPY request_contract.py .
COPY handler.py .

EXPOSE 8000

CMD ["python", "-u", "handler.py"]
