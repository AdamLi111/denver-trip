# 开启多人编辑（Firebase 设置）

网站本身还放在 GitHub Pages。朋友添加的地点和最终路线存在 Firebase 里，所有人打开网页都能看到；只有编辑名单上的 Google 账号能修改。

还没配置 Firebase 时：
- 在 localhost 上打开是「本机测试模式」，可以试用所有编辑功能，但内容只存在你这台电脑的浏览器里。
- 在 GitHub Pages 上是「只读」，编辑按钮会提示功能还没开启。

## 1. 新建 Firebase 项目
1. 打开 <https://console.firebase.google.com/>，用你的 Google 账号登录，点「创建项目」，名字随意（例如 `denver-trip`）。Google Analytics 可以关掉。
2. 默认就是免费的 Spark 方案，不需要绑信用卡。

## 2. 开启 Google 登录
1. 左侧 **Build → Authentication → Get started**。
2. **Sign-in method** 里选 **Google**，打开开关，填一个支持邮箱，保存。
3. 同一页的 **Settings → Authorized domains** 里点 **Add domain**，加上 `adamli111.github.io`（`localhost` 默认已经在里面）。

## 3. 创建数据库并设置安全规则
1. 左侧 **Build → Firestore Database → Create database**，位置选 `us-central1`（或任意美国区域），选 **production mode**。
2. 进入 **Rules** 标签，把本仓库里 [`firestore.rules`](firestore.rules) 的全部内容粘贴进去，点 **Publish**。

## 4. 添加编辑名单
1. 在 Firestore 的 **Data** 标签点 **Start collection**，集合 ID 填 `editors`。
2. 文档 ID 填一个能编辑的人的 Google 邮箱，**全部小写**，例如 `someone@gmail.com`。随便加一个字段（例如 `name` = `Adam`），保存。
3. 每加一个朋友，就在 `editors` 里再加一个以他们邮箱为 ID 的文档。删掉文档就是取消权限。

只有这个名单能修改数据。名单本身只能在 Firebase 控制台里改，网页上改不了。

## 5. 把配置填进网站
1. 项目首页点 **</>（Web）** 图标注册一个 Web 应用（名字随意，不需要 Hosting）。
2. 复制显示出来的 `firebaseConfig = { ... }` 对象，粘贴到 [`firebase-config.js`](firebase-config.js)，替换掉 `null`。
3. 提交并推送：

```bash
git add firebase-config.js && git commit -m "Connect Firebase" && git push
```

`firebaseConfig` 里的值本来就会出现在网页里，放进公开仓库没有问题；真正挡住陌生人的是第 3 步的安全规则和第 4 步的编辑名单。

## 朋友怎么用
1. 打开网站，点右上角「✏️ 编辑行程」→「使用 Google 登录」。
2. 如果提示没有权限，把提示里的邮箱发给你，你按第 4 步加进名单，对方刷新页面即可。
3. 能编辑后，菜单里可以添加 Airbnb、可能的景点、餐厅，或者「确定最终路线」。

## 用到的免费服务
- 路线计算：OSRM 公共服务器（`router.project-osrm.org`），只在「生成最终路线」时调用，适合少量使用。
- 地址搜索：OpenStreetMap Nominatim，只在点「搜索」时调用。
