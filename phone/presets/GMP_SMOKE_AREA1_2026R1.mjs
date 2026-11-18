export default {
  "schema_version": 1,
  "template_id": "GMP_SMOKE_AREA1_2026R1",
  "template_name": "分装一区层流气流流型确认（2026版）",
  "source_doc": "分装一区层流气流流型确认记录",
  "area_name": "分装一区",
  "default_criteria": "烟雾为单向流方式、无湍流、烟雾清晰，并拍摄视频。",
  "actions": [
    {
      "action_id": "S01",
      "name": "隔离器内层流气流",
      "type": "static",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "检查灌装区域隔离器内层流下方气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "1"
      },
      "order": 1,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "S02",
      "name": "延展层流气流",
      "type": "static",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "检查灌装区域灌装延展层流下方气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "2"
      },
      "order": 2,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "S03",
      "name": "隔离器内层流气流",
      "type": "static",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "检查轧盖区域隔离器内层流下方气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "3"
      },
      "order": 3,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "S04",
      "name": "延展层流气流",
      "type": "static",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "检查轧盖区域延展层流下方气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "4"
      },
      "order": 4,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "S05",
      "name": "层流罩气流",
      "type": "static",
      "group": "灭菌后室（CLZ-06-2-J09）",
      "description": "检查灭菌后室层流下方气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "5"
      },
      "order": 5,
      "points": [],
      "room_key": "CLZ-06"
    },
    {
      "action_id": "S06",
      "name": "层流罩气流",
      "type": "static",
      "group": "洗衣间（CLZ-07-2-H14）",
      "description": "检查洗衣间层流下方气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "6"
      },
      "order": 6,
      "points": [],
      "room_key": "CLZ-07"
    },
    {
      "action_id": "S07",
      "name": "层流罩气流",
      "type": "static",
      "group": "消毒剂过滤间（CLZ-04-2-H19）",
      "description": "检查消毒剂过滤间层流下方气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "7"
      },
      "order": 7,
      "points": [],
      "room_key": "CLZ-04"
    },
    {
      "action_id": "S08",
      "name": "层流罩气流",
      "type": "static",
      "group": "精洗间（CLZ-05-2-H16）",
      "description": "检查精洗间层流下方气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "8"
      },
      "order": 8,
      "points": [],
      "room_key": "CLZ-05"
    },
    {
      "action_id": "S09",
      "name": "RABS手套孔洞气流（不装手套）",
      "type": "static",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "检查灌装层流下方RABS手套孔洞附近气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "9"
      },
      "order": 9,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "S10",
      "name": "RABS手套孔洞气流（不装手套）",
      "type": "static",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "检查轧盖层流下方RABS手套孔洞附近气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "10"
      },
      "order": 10,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "S11",
      "name": "A级RABS至背景环境的气流流向",
      "type": "static",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "检查灌装间A级RABS至背景环境的气流流向，包括高效过滤器与不锈钢龙骨架间空隙及隔离器下方空隙的气流",
      "doc_ref": {
        "section": "静态测试",
        "seq": "11"
      },
      "order": 11,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "S12",
      "name": "A级RABS至背景环境的气流流向",
      "type": "static",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "检查轧盖间A级RABS至背景环境的气流流向，包括高效过滤器与不锈钢龙骨架间空隙及隔离器下方空隙的气流",
      "doc_ref": {
        "section": "静态测试",
        "seq": "12"
      },
      "order": 12,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "S13",
      "name": "灌装理瓶盘位置与灭菌隧道的气流流型",
      "type": "static",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "检查灌装理瓶盘位置与灭菌隧道的气流流型",
      "doc_ref": {
        "section": "静态测试",
        "seq": "13"
      },
      "order": 13,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "S14",
      "name": "房间孔洞气流流型",
      "type": "static",
      "group": "灌装间（2-J10）→轧盖间（2-J11）孔洞",
      "description": "检查灌装间对轧盖间孔洞气流方向",
      "doc_ref": {
        "section": "静态测试",
        "seq": "14"
      },
      "order": 14,
      "points": [],
      "room_key": "房间孔洞"
    },
    {
      "action_id": "S15",
      "name": "房间孔洞气流流型",
      "type": "static",
      "group": "轧盖间（2-J11）→缓冲间孔洞",
      "description": "检查轧盖间对缓冲间孔洞气流方向",
      "doc_ref": {
        "section": "静态测试",
        "seq": "15"
      },
      "order": 15,
      "points": [],
      "room_key": "房间孔洞"
    },
    {
      "action_id": "D01",
      "name": "设备开启时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟在线粒子监测系统开启浮游菌采样时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "1"
      },
      "order": 16,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D02",
      "name": "灌装加胶塞过程气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟无菌灌装加胶塞时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "2"
      },
      "order": 17,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D03",
      "name": "灌装铝盖过程气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟加铝盖时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "3"
      },
      "order": 18,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D04",
      "name": "手套伸入时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟无菌灌装手套伸入时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "4"
      },
      "order": 19,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D05",
      "name": "手套伸入时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "模拟轧盖手套伸入时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "5"
      },
      "order": 20,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D06",
      "name": "更换培养皿时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟无菌灌装更换培养皿时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "6"
      },
      "order": 21,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D07",
      "name": "更换培养皿时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "模拟轧盖更换培养皿时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "7"
      },
      "order": 22,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D08",
      "name": "人员活动对气流影响",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "观察操作人员在B级区走动及进入A级区时，气流流型变化",
      "doc_ref": {
        "section": "动态测试",
        "seq": "8"
      },
      "order": 23,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D09",
      "name": "无菌器具安装",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟灌装工位（蠕动泵侧）安装缓冲罐时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "9"
      },
      "order": 24,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D10",
      "name": "无菌器具安装",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟灌装工位（灌针侧）安装灌装针时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "10"
      },
      "order": 25,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D11",
      "name": "设备开启时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟灌装机启动灌装时灌装针运行时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "11"
      },
      "order": 26,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D12",
      "name": "设备开启时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟灌装机启动灌装时理瓶盘运行时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "12"
      },
      "order": 27,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D13",
      "name": "设备开启时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "模拟轧盖机启动灌装时理瓶盘运行时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "13"
      },
      "order": 28,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D14",
      "name": "取样操作时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟取样检查离线装量时，延展层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "14"
      },
      "order": 29,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D15",
      "name": "物品转运对气流影响",
      "type": "dynamic",
      "group": "灌装间（CLZ-09）B级区",
      "description": "模拟房间内物品转运时，延展层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "15"
      },
      "order": 30,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D16",
      "name": "管路连接时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09）延展区域",
      "description": "模拟进行除菌滤器和硅胶软管连接时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "16"
      },
      "order": 31,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D17",
      "name": "理瓶盘倒瓶干预时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟伸入隔离手套处理理瓶盘倒瓶时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "17"
      },
      "order": 32,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D18",
      "name": "进瓶星轮过载干预时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟打开隔离门处理进瓶星轮过载时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "18"
      },
      "order": 33,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D19",
      "name": "胶塞工位异常干预时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟伸入隔离手套处理胶塞工位异常时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "19"
      },
      "order": 34,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D20",
      "name": "剔废星轮过载干预时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟打开隔离门处理剔废星轮过载异常时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "20"
      },
      "order": 35,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D21",
      "name": "灌装工位异常干预时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟伸入手套处理灌装工位异常时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "21"
      },
      "order": 36,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D22",
      "name": "人员穿越A级对气流影响",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟人员穿越A级生产线时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "22"
      },
      "order": 37,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D23",
      "name": "人员穿越A级对气流影响",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟人员穿越A级生产线时的边界气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "23"
      },
      "order": 38,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D24",
      "name": "人员穿越A级时压塞轨道孔洞气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09）压塞/走带区域",
      "description": "模拟人员穿越A级生产线（输送走带工位）时，检查压塞轨道孔洞气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "24"
      },
      "order": 39,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D25",
      "name": "传递窗口操作时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）无菌物料传递窗口",
      "description": "模拟无菌传递窗口打开，人员传递物件时，工位延展区域气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "25"
      },
      "order": 40,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D26",
      "name": "无菌灌装器具组装",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "模拟组装组装胶塞锅、胶塞锁、送料盘、上塞斗、胶塞盒时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "26"
      },
      "order": 41,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D27",
      "name": "器具传入后气流恢复时间",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）无菌物料传递窗口",
      "description": "模拟器具传入A级后，关闭无菌传递窗口，检查层流下方气流恢复时间",
      "doc_ref": {
        "section": "动态测试",
        "seq": "27"
      },
      "order": 42,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D28",
      "name": "轧盖理瓶盘异常开门干预时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "模拟打开隔离门处理轧盖理瓶盘异常时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "28"
      },
      "order": 43,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D29",
      "name": "铝盖震荡锅异常开门干预时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "模拟打开隔离门处理铝盖震荡锅异常时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "29"
      },
      "order": 44,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D30",
      "name": "加塞工位胶塞锁卡塞干预时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "加塞工位干预：人手通过手套箱进入RABS系统，用镊子处理胶塞锁卡塞",
      "doc_ref": {
        "section": "动态测试",
        "seq": "30"
      },
      "order": 45,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D31",
      "name": "加塞工位辅助器具装配干预时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "加塞工位干预：人手通过手套箱进入RABS系统，用手套辅助灌装器具装配",
      "doc_ref": {
        "section": "动态测试",
        "seq": "31"
      },
      "order": 46,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D32",
      "name": "输送走带工位干预时气流",
      "type": "dynamic",
      "group": "灌装间（CLZ-09-2-J10）",
      "description": "输送走带工位干预：人手通过手套箱进入RABS系统，用镊子将玻璃瓶手动输送至轧盖间",
      "doc_ref": {
        "section": "动态测试",
        "seq": "32"
      },
      "order": 47,
      "points": [],
      "room_key": "CLZ-09"
    },
    {
      "action_id": "D33",
      "name": "理瓶盘工位转运干预时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "理瓶盘工位干预：人手通过手套箱进入RABS系统，用镊子将玻璃瓶从理瓶盘输送至进料输送带",
      "doc_ref": {
        "section": "动态测试",
        "seq": "33"
      },
      "order": 48,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D34",
      "name": "理瓶盘工位进料螺杆过载干预时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "理瓶盘工位干预：人手通过手套箱进入RABS系统，用隔离手套和镊子处理进料螺杆过载",
      "doc_ref": {
        "section": "动态测试",
        "seq": "34"
      },
      "order": 49,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D35",
      "name": "轧盖工位出盖轨道卡盖干预时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "轧盖工位干预：人手通过手套箱进入RABS系统，用镊子处理出盖轨道卡盖",
      "doc_ref": {
        "section": "动态测试",
        "seq": "35"
      },
      "order": 50,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D36",
      "name": "铝盖检测探头故障干预时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "轧盖工位干预：人手通过手套箱进入RABS系统，用镊子处理铝盖检测探头故障",
      "doc_ref": {
        "section": "动态测试",
        "seq": "36"
      },
      "order": 51,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D37",
      "name": "胶塞检测探头故障干预时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "轧盖工位干预：人手通过手套箱进入RABS系统，用隔离手套和镊子处理胶塞检测探头故障",
      "doc_ref": {
        "section": "动态测试",
        "seq": "37"
      },
      "order": 52,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D38",
      "name": "轧盖工位更换平皿干预时气流",
      "type": "dynamic",
      "group": "轧盖间（CLZ-08-2-J11）",
      "description": "轧盖工位干预：人手通过手套箱进入RABS系统，用隔离手套更换平皿",
      "doc_ref": {
        "section": "动态测试",
        "seq": "38"
      },
      "order": 53,
      "points": [],
      "room_key": "CLZ-08"
    },
    {
      "action_id": "D39",
      "name": "模拟实际生产操作",
      "type": "dynamic",
      "group": "灭菌后室（CLZ-06-2-J09）",
      "description": "模拟实际生产中的打开灭菌器门传递无菌物品时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "39"
      },
      "order": 54,
      "points": [],
      "room_key": "CLZ-06"
    },
    {
      "action_id": "D40",
      "name": "模拟实际生产操作",
      "type": "dynamic",
      "group": "洗衣间（CLZ-07-2-H14）",
      "description": "模拟实际生产中叠衣服时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "40"
      },
      "order": 55,
      "points": [],
      "room_key": "CLZ-07"
    },
    {
      "action_id": "D41",
      "name": "模拟实际生产操作",
      "type": "dynamic",
      "group": "消毒剂过滤间（CLZ-04-2-H19）",
      "description": "模拟实际生产中消毒剂过滤工作时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "41"
      },
      "order": 56,
      "points": [],
      "room_key": "CLZ-04"
    },
    {
      "action_id": "D42",
      "name": "模拟实际生产操作",
      "type": "dynamic",
      "group": "精洗间（CLZ-05-2-H16）",
      "description": "模拟实际生产中清洗工作时，层流下方气流",
      "doc_ref": {
        "section": "动态测试",
        "seq": "42"
      },
      "order": 57,
      "points": [],
      "room_key": "CLZ-05"
    }
  ]
};
