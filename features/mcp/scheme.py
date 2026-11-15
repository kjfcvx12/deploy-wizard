from datetime import datetime

from pydantic import BaseModel


# MCP 결과로 내보낼 배포 필드 허용 목록 - 여기 없는 필드는 나가지 않는다
class Deploy_Summary(BaseModel):
    d_id:int
    repo_url:str
    branch:str|None=None
    status:str
    language:str|None=None
    endpoint:str|None=None
    error_step:str|None=None
    error_msg:str|None=None
    health_state:str="unknown"
    created_at:datetime


# MCP 결과로 내보낼 연결 필드 허용 목록 - aws: a_id/status/region/account, github: g_id/status/repository_selection
class Connection_Summary(BaseModel):
    c_id:int
    label:str
    aws:dict|None=None
    github:dict|None=None
