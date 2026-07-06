import duckdb
db = duckdb.connect("PennyWise.duckdb")
        
        # 1. 创建序列（如果不存在则创建，已存在则跳过，保留原计数）
db.execute("CREATE SEQUENCE IF NOT EXISTS bill_id_seq START 1")
        
        # 2. 创建表 bill（如果不存在则创建，已存在则跳过，旧数据完整保留）
db.execute("""
    CREATE TABLE IF NOT EXISTS bill (
    id INTEGER PRIMARY KEY DEFAULT nextval('bill_id_seq'),
    amount INTEGER NOT NULL,  -- 单位：分
    merchant TEXT NOT NULL,
    goods_name TEXT NOT NULL,
    category TEXT NOT NULL,
    transaction_time TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)
""")                   #这里把amout单位改成分，防止出现浮点数精度错乱
db.close()



def insert_transaction(bill_data):
    db = duckdb.connect("PennyWise.duckdb")    # 新增账单 ，返回账单编号和是否成功，成功返回账单编号和True，失败返回错误信息和False
    params = [
    int(bill_data["amount"] * 100),  # 转换为分
    bill_data["merchant"],
    bill_data["goods_name"],
    bill_data["category"],
    bill_data["transaction_time"],
    bill_data["raw_text"]
]
    insert_sql = """
INSERT INTO bill (amount, merchant, goods_name, category, transaction_time, raw_text, create_time)
VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
"""
    try:
        db.execute(insert_sql, params)
        print("账单新增成功！")
        new_id = db.execute("SELECT currval('bill_id_seq')").fetchone()[0]
        print(f"当前账单编号：{new_id}")
        db.close()
        IsSuccess=True
        return new_id,IsSuccess
    except duckdb.Error as e:
        print(f"账单新增失败！{e}")
        db.close()
        IsSuccess=False
        return e,IsSuccess
    


def get_all_transactions():   #获取所有账单记录，按交易时间降序排列
    db = duckdb.connect("PennyWise.duckdb")
    command = """
    SELECT * FROM bill ORDER BY transaction_time DESC ;
    """
    result = db.execute(command).fetchall()
    for item in result:
        print(item)
    db.close()
    return result



def get_transaction_by_id(bill_id):   #根据账单编号获取账单记录
    db = duckdb.connect("PennyWise.duckdb")
    command = f"""
    SELECT * FROM bill WHERE id={bill_id};
    """
    result = db.execute(command).fetchone()
    print(result)
    db.close()
    return result

bill_data = {
    "amount": 1,
    "merchant": "测试商户",
    "goods_name": "测试商品",
    "category": "测试分类",
    "transaction_time": "2023-10-01 12:00:00",
    "raw_text": "测试原始文本"
}












get_transaction_by_id(3)