# Stand-in for DeepSpeed, which resemble-enhance imports for its training code. Regeneration
# only runs inference (server/regen/regen.py), which never calls any of this.
class _Dummy:
    def __init__(self, *a, **k): pass
    def __getattr__(self, n): return _Dummy()
    def __call__(self, *a, **k): return _Dummy()


DeepSpeedConfig = _Dummy


def __getattr__(name):
    return _Dummy()
