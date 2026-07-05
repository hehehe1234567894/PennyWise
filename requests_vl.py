import dashscope
import json
from datetime import datetime
from dashscope import MultiModalConversation

dashscope.api_key = "sk-ws-H.RXXRRYD.DRUP.MEUCIQDuThnC97J4W8IHFeVEwVjgmdFcLxoFcTjFvudR2mkXxAIgEe5zmO6j8sle-GCc28cs2vWiNOrb6Mx6cV3aSgeqvBg"

def convert_data_type(data, float_fields: list):
    for key in float_fields:
        if key in data:
            val = data[key]
            try:
                data[key] = float(val)
            except:
                pass
    return data

def qwen_vl_fix_json(image_path: str, prompt: str, schema_with_type: str, float_keys: list):
    now_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    system_text = f"""
1. 仅输出纯净JSON，禁止```、注释、多余解释文字；
2. 严格遵循下方JSON Schema规范：
{schema_with_type}
3. number类型输出裸数字，不加双引号；string必须双引号包裹；
4. 图片无交易时间时，transaction_time填充{now_time}；
5. merchant清除「收款方：」「商户：」等前缀；
6. category仅使用枚举内值，匹配不到填"其他"；
7. 无商品名称时goods_name填空字符串；
8. 禁止返回schema以外的任何额外字段。
"""
    messages = [
        {
            "role": "system",
            "content": [{"text": system_text}]
        },
        {
            "role": "user",
            "content": [
                {"image": f"file://{image_path}"},
                {"text": prompt}
            ]
        }
    ]

    resp = MultiModalConversation.call(
        model="qwen-vl-plus",
        messages=messages,
        result_format="message",
        parameters={
            "response_format": {"type": "json_object"},
            "temperature": 0.01
        }
    )

    if resp.status_code != 200:
        return {"code": resp.code, "msg": resp.message, "data": None}

    raw_text = resp.output.choices[0].message.content[0]["text"]
    raw_text = raw_text.replace("```json", "").replace("```", "").strip()
    try:
        json_dict = json.loads(raw_text)
        json_dict = convert_data_type(json_dict, float_keys)
        return {"code": 0, "msg": "success", "data": json_dict}
    except Exception as e:
        return {"code": -1, "msg": f"JSON解析异常:{str(e)}", "raw": raw_text}

def request_vl():
    schema = '''
{
    "type": "object",
    "additionalProperties": false,
    "properties": {
        "amount": {
            "type": "number",
            "description": "实付金额，忽略余额、优惠券、原价，仅取真实扣款",
            "minimum": 0
        },
        "merchant": {
            "type": "string",
            "description": "商户名，仅保留收款方名称，不带收款方/商户前缀文字"
        },
        "goods_name": {
            "type": "string",
            "description": "购买的商品/服务名称，无具体商品则填空字符串"
        },
        "category": {
            "type": "string",
            "enum": ["餐饮", "交通", "购物", "娱乐", "生活缴费", "转账", "红包", "运动", "其他"],
            "description": "消费类别，只能从枚举中选取，无法匹配则填其他"
        },
        "transaction_time": {
            "type": "string",
            "format": "YYYY-MM-DD HH:MM:SS",
            "pattern": "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$",
            "description": "交易时间，截图无时间则填充当前系统时间"
        },
        "raw_text": {
            "type": "string",
            "description": "图片完整原始文本，用于日志审计"
        }
    },
    "required": ["amount", "merchant", "goods_name", "category", "transaction_time", "raw_text"]
}
'''
    need_float = ["amount"]

    result = qwen_vl_fix_json("./111.jpg", "提取支付账单截图结构化信息，识别商品名称", schema, need_float)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result["code"] == 0:
        data = result["data"]
        print("实付金额:", data["amount"])
        print("商户:", data["merchant"])
        print("商品名称:", data["goods_name"])
        print("分类:", data["category"])
        print("交易时间:", data["transaction_time"])