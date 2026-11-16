# 소유권 필터 (로그인 계획 Task 5) - 최상위 표는 u_id 로, 자식 표는 부모 표를 따라간다
# u_id 가 None 이면 인증 끔 모드라 거르지 않는다. 인증 켬 모드에서는 현재 사용자 의존성이 None 을 내지 않는다


# 조회문에 주인 조건을 붙인다 - u_id 가 None 이면 그대로 돌려준다
def owner_where(stmt, column, u_id:int|None):
    if u_id is None:
        return stmt
    return stmt.where(column == u_id)
