import os
import re
import xml.etree.ElementTree as ET
import email.mime.text
import functools
from typing import (
    Any,  # comment
    Optional as Opt,
)
from collections import deque, OrderedDict
from dataclasses import dataclass
from math import pi, inf
from string import ascii_letters as LETTERS
from os import path
try:
    import ujson as json
except ImportError:
    import json
try:
    import yaml
except ImportError:
    yaml = None

def shadow_param(os):
    return os.sep

def shadow_for(xs):
    for json in xs:
        json.loads("1")
    return re.compile("x")

def closure():
    def inner():
        return re.match("a", "b")
    return inner

def local_import():
    import sqlite3
    return sqlite3.connect(":memory:")

def no_local():
    return sqlite3

class A:
    import shutil
    sep = shutil.which("ls")
    def m(self):
        return shutil

def labels(f):
    f(os=1, path=2)
    return f.os, f.path

def strings():
    # os.path and re here are prose
    s = "os.path re"
    t = f"{os.sep} {re.escape('x')}"
    return s, t

def typed(x: Opt[int], q: deque) -> Any:
    y: deque = deque()
    if isinstance(x, (deque, OrderedDict)):
        return ET.fromstring("<a/>")
    return email.mime.text, LETTERS, pi, inf, path.join("a")

def lambdas():
    return lambda deque: deque

def rebind_global():
    global functools
    functools = None

def comp(xs):
    return [ET for ET in xs]

def deleting():
    del re

def with_as():
    with open("f") as json:
        return json

def walrus(v):
    if (yaml := v):
        return yaml

@functools.wraps(print)
@dataclass
def decorated():
    print(os, OrderedDict)  # type: os.PathLike
    return yaml.safe_load("a")
