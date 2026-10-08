from pydantic import BaseModel


# 웹훅 처리 결과 - 매칭된 배포 수, 그중 디바운스로 예약된 수
class Watch_Ack(BaseModel):
    matched: int
    debounced: int
