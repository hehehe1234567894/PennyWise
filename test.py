import duckdb

conn = duckdb.connect('my_database.db')  # 或使用内存数据库 ':memory:'

# 创建表（根据你的实际字段调整）
create_sql = """
CREATE TABLE IF NOT EXISTS bill (
    id INTEGER,
    amount DECIMAL(10,2),
    description VARCHAR,
    date DATE
)
"""
conn.execute(create_sql)
insert_sql = "INSERT INTO bill (id, amount, description, date) VALUES (?, ?, ?, ?)"
params = (1, 99.9, '测试', '2026-07-05')
conn.execute(insert_sql, params)