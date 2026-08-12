/**
 * 统一类型与球场适配器接口规范
 * 新增球场时, 适配器需实现下面 VenueAdapter 约定的方法。
 */

/**
 * @typedef {Object} VenueMeta      球场展示/配置信息(来自 venue.yml)
 * @property {string} id            球场唯一标识(=目录名), 如 "picklepop"
 * @property {string} name          展示名, 如 "PICKLE POP 宝安摩天轮馆"
 * @property {string} [logo]        logo URL
 * @property {string} [desc]        描述
 * @property {Object} [advanceDays] 放场提前天数 { [projectType]: number }
 * @property {Array}  [courts]      场地列表(展示用)
 * @property {Object} [raw]         原始 yml 全部内容
 */

/**
 * @typedef {Object} Credential     某球场的凭证(来自 data/credentials.json)
 * 结构由各球场自定义。picklepop: { PSPLVISITORID: string }
 */

/**
 * @typedef {Object} ReadyResult
 * @property {boolean} ok           是否就绪(可抢)
 * @property {string}  [detail]     详情(如登录态/余额/失效原因)
 * @property {Object}  [extra]      额外信息(如余额)
 */

/**
 * @typedef {Object} GrabTarget     抢票目标(球场无关的通用结构)
 * @property {string} court         场地名或标识
 * @property {string} date          日期 YYYY-MM-DD
 * @property {string} time          开始时刻 HH:mm
 * @property {number} [cost]        价格(用于余额支付校验)
 * @property {Object} [ext]         球场特有的额外字段
 */

/**
 * @typedef {Object} GrabResult
 * @property {boolean} success
 * @property {string}  [orderId]    订单标识(如 apptUid)
 * @property {string}  [message]
 * @property {Object}  [raw]        原始返回
 */

/**
 * 球场适配器需实现的接口:
 * @typedef {Object} VenueAdapter
 * @property {VenueMeta} meta
 * @property {(cred: Credential) => Promise<ReadyResult>} ready
 *           ready检测入口。picklepop = 检测 PSPLVISITORID 有效性。
 * @property {(target: GrabTarget, cred: Credential) => Promise<GrabResult>} grab
 *           抢票入口。
 * @property {(query: Object, cred: Credential) => Promise<any>} [listSlots]
 *           (可选)查询可约时段。
 */

export {};
