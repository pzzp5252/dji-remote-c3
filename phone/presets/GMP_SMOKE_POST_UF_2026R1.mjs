export default {
  "schema_version": 1,
  "template_id": "GMP_SMOKE_POST_UF_2026R1",
  "template_name": "后超滤灭活区层流气流流型确认（2026版）",
  "source_doc": "C、D级区域层流气流流型确认记录",
  "area_name": "后超滤灭活区",
  "default_criteria": "烟雾为单向流方式、无湍流、烟雾清晰，并拍摄视频。",
  "actions": [
    {
      "action_id": "S01",
      "name": "层流罩静态气流",
      "type": "static",
      "group": "CLZ-10（2-G28过滤间一）",
      "description": "检查过滤间一层流下方气流流型",
      "doc_ref": {
        "section": "后超滤区气流流型静态测试",
        "seq": "1"
      },
      "order": 1,
      "points": [],
      "room_key": "CLZ-10"
    },
    {
      "action_id": "S02",
      "name": "层流罩静态气流",
      "type": "static",
      "group": "CLZ-12（2-G18过滤间二）",
      "description": "检查过滤间二层流下方气流流型",
      "doc_ref": {
        "section": "后超滤区气流流型静态测试",
        "seq": "2"
      },
      "order": 2,
      "points": [],
      "room_key": "CLZ-12"
    },
    {
      "action_id": "S03",
      "name": "层流罩静态气流",
      "type": "static",
      "group": "CLZ-11（2-G08洗衣间）",
      "description": "检查洗衣间层流下方气流流型",
      "doc_ref": {
        "section": "后超滤区气流流型静态测试",
        "seq": "3"
      },
      "order": 3,
      "points": [],
      "room_key": "CLZ-11"
    },
    {
      "action_id": "D01",
      "name": "层流罩动态气流",
      "type": "dynamic",
      "group": "CLZ-10（2-G28过滤间一）",
      "description": "模拟除菌过滤动态过程中，过滤间一层流下方气流流型",
      "doc_ref": {
        "section": "后超滤区气流流型动态测试",
        "seq": "1"
      },
      "order": 4,
      "points": [],
      "room_key": "CLZ-10"
    },
    {
      "action_id": "D02",
      "name": "层流罩动态气流",
      "type": "dynamic",
      "group": "CLZ-12（2-G18过滤间二）",
      "description": "模拟制品移动罐与分装区除菌过滤管道连接动态过程中，过滤间二层流下方气流流型",
      "doc_ref": {
        "section": "后超滤区气流流型动态测试",
        "seq": "2"
      },
      "order": 5,
      "points": [],
      "room_key": "CLZ-12"
    },
    {
      "action_id": "D03",
      "name": "层流罩动态气流",
      "type": "dynamic",
      "group": "CLZ-11（2-G08洗衣间）",
      "description": "模拟洁净服整理过程中，层流下方气流流型",
      "doc_ref": {
        "section": "后超滤区气流流型动态测试",
        "seq": "3"
      },
      "order": 6,
      "points": [],
      "room_key": "CLZ-11"
    }
  ]
};
