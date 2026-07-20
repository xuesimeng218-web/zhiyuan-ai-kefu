# 数据结构规范说明

## 1. 当前 7 个 data 分类文件与变量名

当前页面通过 7 个分类脚本文件暴露全局变量，分别为：

- [data/presale.js](../data/presale.js)：`window.KB_PRESALE`
- [data/aftersale-onhold.js](../data/aftersale-onhold.js)：`window.KB_AFTERSALE_ONHOLD`
- [data/aftersale-actions.js](../data/aftersale-actions.js)：`window.KB_AFTERSALE_ACTIONS`
- [data/other.js](../data/other.js)：`window.KB_OTHER`
- [data/products.js](../data/products.js)：`window.KB_PRODUCTS`
- [data/tutorials.js](../data/tutorials.js)：`window.KB_TUTORIALS`
- [data/training.js](../data/training.js)：`window.KB_TRAINING`

## 2. 当前各分类内容数量与总数量

| 分类文件 | 分类标题 | 内容数量 |
| --- | --- | ---: |
| [data/presale.js](../data/presale.js) | 售前 | 10 |
| [data/aftersale-onhold.js](../data/aftersale-onhold.js) | 售后 · on hold 触发 | 4 |
| [data/aftersale-actions.js](../data/aftersale-actions.js) | 售后 · 处置动作 | 5 |
| [data/other.js](../data/other.js) | 其他 | 2 |
| [data/products.js](../data/products.js) | 产品中心 | 3 |
| [data/tutorials.js](../data/tutorials.js) | 操作教程 | 3 |
| [data/training.js](../data/training.js) | 新人培训 | 2 |

- 当前运行态分类组数：7
- 当前运行态内容总数量：29

## 3. 分类对象和内容对象当前包含的字段

### 分类对象

当前分类对象的结构为：

```js
{
  title: "分类标题",
  items: [
    {
      title: "内容标题",
      paragraphs: ["段落 1", "段落 2"]
    }
  ]
}
```

字段说明：

- `title`：分类标题
- `items`：该分类下的内容数组

### 内容对象

当前内容对象字段为：

- `title`：内容标题
- `paragraphs`：内容段落数组

说明：当前没有显式 `id` 字段，内容识别依赖数组位置。

## 4. [data/data.js](../data/data.js) 的汇总方式

[data/data.js](../data/data.js) 仅做汇总，使用数组顺序把各分类对象拼接成一个 `ORIGINAL_DATA` 数组：

```js
const ORIGINAL_DATA = [
  window.KB_PRESALE,
  window.KB_AFTERSALE_ONHOLD,
  window.KB_AFTERSALE_ACTIONS,
  window.KB_OTHER,
  window.KB_PRODUCTS,
  window.KB_TUTORIALS,
  window.KB_TRAINING,
];
```

这个数组是页面初始化时默认数据源。

## 5. [js/script.js](../js/script.js) 与 [js/search.js](../js/search.js) 如何读取数据

### [js/script.js](../js/script.js)

- 先从 [data/data.js](../data/data.js) 的 `ORIGINAL_DATA` 初始化 `groups`：
  - `groups = JSON.parse(localStorage.getItem(KEY) || "null") || structuredClone(ORIGINAL_DATA);`
- 后续页面中的导航、详情、收藏、最近使用、导入导出等逻辑，都基于 `groups` 数组读取：
  - `groups[gi].title`
  - `groups[gi].items`
  - `groups[gi].items[ii].title`
  - `groups[gi].items[ii].paragraphs`

### [js/search.js](../js/search.js)

- `allDocs()` 会把 `groups` 扁平化为所有内容项，方便全文搜索与列表展示。
- `renderList()` 会根据搜索关键字过滤内容，并把内容标题、分类标题、段落摘要渲染到列表中。

## 6. 当前基于数组位置生成 ID 的风险

当前页面没有显式内容 ID，实际使用的是由 [js/script.js](../js/script.js) 中的 `id(g, i)` 生成的逻辑 ID：

```js
function id(g, i) {
  return g + "-" + i;
}
```

这意味着：

- ID 依赖分类索引和内容索引，而不是稳定主键；
- 若未来新增、删除或重排内容，收藏和最近使用记录会出现“漂移”现象；
- 这会影响历史记录、导入导出后的引用稳定性，且后续迁移到 PostgreSQL 时会增加对账和迁移成本。

## 7. PostgreSQL 建议使用的固定字段

未来迁移到 PostgreSQL 时，建议统一使用以下字段：

- `category_id`
- `category_title`
- `content_id`
- `content_title`
- `body_text`
- `sort_order`
- `created_at`
- `updated_at`

建议说明：

- `category_id` / `content_id` 用于稳定关联和外键约束；
- `body_text` 统一存储正文内容，避免依赖 `paragraphs` 数组；
- `sort_order` 用于控制展示顺序；
- `created_at` / `updated_at` 用于审计和同步。

## 8. 本步骤说明

本步骤仅建立规范文档，不改变当前网页运行逻辑。

- 不修改任何现有数据文件；
- 不修改 [index.html](../index.html)、[js/script.js](../js/script.js)、[js/search.js](../js/search.js) 或任何现有运行逻辑；
- 仅为后续迁移和规范化提供文档基础。
