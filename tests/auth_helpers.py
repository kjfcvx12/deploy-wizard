from shared.secrets import blind_index


# 로그인 계획 공용 시험 도우미 - 사용자 만들기·인증 헤더 (Task 4 이후의 소유권 시험이 같이 쓴다)


# 사용자 하나를 바로 만든다 (Google 로그인 없이) - 반환: u_id
async def make_user(db, email:str, status:str="active") -> int:
    from features.auth.crud import Auth_Crud

    db_user=await Auth_Crud.crud_user_create(db, {"google_sub": "sub-" + email, "google_sub_bidx": blind_index("google_sub", "sub-" + email),
                                                  "email": email, "email_bidx": blind_index("email", email), "status": status})
    await db.commit()
    return db_user.u_id


# 액세스 토큰 헤더 - u_id 로 바로 발급한다
def auth_header(u_id:int) -> dict:
    from features.auth.services import Auth_Service

    return {"Authorization": f"Bearer {Auth_Service.services_auth_access_issue(u_id)}"}
