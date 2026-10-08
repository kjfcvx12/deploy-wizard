import subprocess
import threading
from typing import Callable

from shared.masking import mask_text

# git, docker 같은 외부 명령 실행 공통
# shell=True 금지 - 인자는 항상 리스트로 넘긴다 (레포 주소가 사용자 입력이다)


class Proc_Error(Exception):
    def __init__(self, message:str, output:str=""):
        super().__init__(message)
        self.output=output


# 명령 실행 - 출력 한 줄마다 on_line 호출, 전체 출력을 돌려준다
def proc_run(args:list[str], cwd:str|None=None, timeout:int=600,
             on_line:Callable[[str], None]|None=None, stdin_text:str|None=None) -> str:
    lines:list[str]=[]
    timed_out=threading.Event()

    try:
        process=subprocess.Popen(
            args,
            cwd=cwd,
            stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    except FileNotFoundError:
        raise Proc_Error(f"명령을 찾을 수 없습니다 :{args[0]}")

    # 출력을 읽는 동안에도 시간 초과가 걸리도록 타이머로 죽인다
    def kill_on_timeout():
        timed_out.set()
        process.kill()

    timer=threading.Timer(timeout, kill_on_timeout)
    timer.start()

    try:
        if stdin_text is not None:
            process.stdin.write(stdin_text)
            process.stdin.close()

        for line in process.stdout:
            line=mask_text(line.rstrip())
            lines.append(line)
            if on_line and line:
                on_line(line)

        process.wait()

    finally:
        timer.cancel()

    output="\n".join(lines)

    if timed_out.is_set():
        raise Proc_Error(f"시간 초과 ({timeout}초) :{args[0]}", output)

    if process.returncode != 0:
        raise Proc_Error(f"명령 실패 (exit {process.returncode}) :{' '.join(args[:3])}", output)

    return output
