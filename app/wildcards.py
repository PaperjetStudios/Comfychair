"""Prompt wildcards: {red|green|blue} picks one option at random each run.

Options can be empty ({wet |}) and groups can nest ({a {big|small} dog|a cat}), including a group with
one option around another ({pushes her {down|over}}), which just loses its braces. Braces with no "|"
anywhere inside are left alone, so JSON or other literal braces pass through, and so does an unmatched
"{" or "}".
"""
import random


class _Group:
    def __init__(self):
        self.options = [[]]  # each option: a list of str and _Group parts

    @property
    def wild(self) -> bool:
        return len(self.options) > 1 or any(isinstance(p, _Group) and p.wild for p in self.options[0])


def _parse(text: str) -> list:
    root = _Group()
    stack = [root]
    for ch in text:
        if ch == "{":
            g = _Group()
            stack[-1].options[-1].append(g)
            stack.append(g)
        elif ch == "}" and len(stack) > 1:
            stack.pop()
        elif ch == "|" and len(stack) > 1:
            stack[-1].options.append([])
        else:
            stack[-1].options[-1].append(ch)
    while len(stack) > 1:  # never closed: put it back as plain text
        g = stack.pop()
        parent = stack[-1].options[-1]
        parent.pop()
        parent.append("{")
        for i, opt in enumerate(g.options):
            if i:
                parent.append("|")
            parent.extend(opt)
    return root.options[0]


def _render(parts: list, rng) -> str:
    out = []
    for p in parts:
        if isinstance(p, str):
            out.append(p)
        elif p.wild:
            out.append(_render(rng.choice(p.options), rng))
        else:
            out.append("{" + _render(p.options[0], rng) + "}")
    return "".join(out)


def has(text) -> bool:
    def any_wild(parts):
        return any(isinstance(p, _Group) and p.wild for p in parts)
    return isinstance(text, str) and "{" in text and any_wild(_parse(text))


def expand(text: str, rng: random.Random = random) -> str:
    return _render(_parse(text), rng)

