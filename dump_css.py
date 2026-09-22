# -*- coding: utf-8 -*-
import re
p = r'D:/TRAE/WYMJ/css/game.css'
s = open(p, encoding='utf-8').read()
rules = re.split(r'(?<=})\s*\n\s*(?=[.#a-zA-Z])', s)
keys = ['.seat-top','.seat-left','.seat-right','.my-hand','.hand','.my-pond','.action-bar','.my-melds','.center-area','.center-wall','#myHand','.pond-top','.pond-left','.pond-right','.seat-avatar','.seat-info','.right-hand','.top-hand','.left-back']
for r in rules:
    head = r.lstrip('\n').split('\n')[0].strip()
    if any(k in head for k in keys):
        compact = ' '.join(x.strip() for x in r.strip().splitlines())
        print(head, '>>', compact[:220])
        print('---')