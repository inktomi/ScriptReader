"""Import-time stubs shared by every server test module.

torch, soundfile, librosa and kokoro are GPU or native dependencies these unit
tests never really exercise. Each test module used to install its own partial
stub through sys.modules.setdefault, so a module only saw a complete stub when
an alphabetically earlier one had already registered a richer version:
`pytest server/test_engine_kokoro.py` on its own failed against a torch stub
with no Tensor attribute, and `pytest server/test_handler.py` against a
soundfile stub with no write. Installing one complete set from a single place
keeps every module runnable by itself, under pytest or unittest.

Importing this module installs the stubs as a side effect, so import it before
anything that pulls in handler or the engines. A real installed dependency is
always left alone.
"""

import sys
import types

import numpy as np


class FakeInferenceMode:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeTensor:
    """Stands in for torch.Tensor: detach/cpu/squeeze/numpy, plus __array__.

    __array__ means the engines' np.asarray fallback yields the same result as
    their tensor branch, so these tests behave the same whether or not a real
    torch is installed alongside them.
    """

    def __init__(self, array):
        self._array = np.asarray(array, dtype=np.float32)

    def detach(self):
        return self

    def cpu(self):
        return self

    def squeeze(self):
        return FakeTensor(self._array.squeeze())

    def numpy(self):
        return self._array

    def __array__(self, dtype=None, **_kwargs):
        return self._array if dtype is None else self._array.astype(dtype)


class FakeSoundFile:
    @staticmethod
    def read(buffer, dtype="float32"):
        return np.full(2400, 0.1, dtype=np.float32), 24000

    @staticmethod
    def write(target, audio, sample_rate, format=None, subtype=None):
        pass


def _install():
    sys.modules.setdefault("torch", types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: False),
        inference_mode=lambda: FakeInferenceMode(),
        backends=types.SimpleNamespace(
            cuda=types.SimpleNamespace(matmul=types.SimpleNamespace(allow_tf32=True)),
            cudnn=types.SimpleNamespace(allow_tf32=True),
        ),
        Tensor=FakeTensor,
    ))
    sys.modules.setdefault("soundfile", FakeSoundFile)
    sys.modules.setdefault("librosa", types.SimpleNamespace(
        effects=types.SimpleNamespace(time_stretch=lambda y, rate=1.0, **kwargs: y),
    ))
    # KPipeline must exist as an attribute for mock.patch("kokoro.KPipeline").
    sys.modules.setdefault("kokoro", types.SimpleNamespace(KPipeline=None))


_install()
