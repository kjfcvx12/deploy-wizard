import asyncio
from contextlib import asynccontextmanager


# 키별 잠금 - 같은 키는 한 번에 하나만 들어간다. 쓰는 사람이 없어지면 항목을 지운다 (쌓이지 않고, 끝난 이벤트 루프에 묶인 잠금을 다시 쓰지 않는다)
# locks 는 {키: [잠금, 쓰는 수]} 모양의 딕셔너리 - 이벤트 루프 한 개 안에서만 부른다
@asynccontextmanager
async def keyed_lock(locks:dict, key):
    entry=locks.get(key)
    if entry is None:
        entry=locks[key]=[asyncio.Lock(), 0]

    entry[1]+=1

    try:
        async with entry[0]:
            yield

    finally:
        entry[1]-=1
        if entry[1] == 0 and locks.get(key) is entry:
            del locks[key]
