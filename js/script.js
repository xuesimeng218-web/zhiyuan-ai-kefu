const KEY = "zy_kb_system_v2",
        FKEY = "zy_kb_favs_v2",
        RKEY = "zy_kb_recent_v2";
      let groups =
        JSON.parse(localStorage.getItem(KEY) || "null") ||
        structuredClone(ORIGINAL_DATA);
      let favs = JSON.parse(localStorage.getItem(FKEY) || "[]");
      let recent = JSON.parse(localStorage.getItem(RKEY) || "[]");
      let mode = "home",
        activeG = 0,
        activeI = 0,
        editing = false;
      const $ = (s) => document.querySelector(s);
      function esc(s) {
        return String(s ?? "").replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[c],
        );
      }
      function id(g, i) {
        return g + "-" + i;
      }
      function toast(s) {
        let t = $("#toast");
        t.textContent = s;
        t.classList.add("show");
        clearTimeout(window.tt);
        window.tt = setTimeout(() => t.classList.remove("show"), 1200);
      }
      function save() {
        localStorage.setItem(KEY, JSON.stringify(groups));
        localStorage.setItem(FKEY, JSON.stringify(favs));
        localStorage.setItem(RKEY, JSON.stringify(recent));
        renderNav();
      }
      function copyText(s) {
        navigator.clipboard
          ?.writeText(s)
          .then(() => toast("已复制"))
          .catch(() => {
            let a = document.createElement("textarea");
            a.value = s;
            document.body.appendChild(a);
            a.select();
            document.execCommand("copy");
            a.remove();
            toast("已复制");
          });
      }
      function setMode(m) {
        mode = m;
        document
          .querySelectorAll(".navbtn[data-mode]")
          .forEach((x) => x.classList.toggle("on", x.dataset.mode === m));
      }
      function renderNav() {
        let total = 0;
        $("#cats").innerHTML = groups
          .map((g, gi) => {
            total += g.items.length;
            return `<button class="navbtn ${mode === "group" && gi === activeG ? "on" : ""}" onclick="openGroup(${gi})">📁 ${esc(g.title)} <em>${g.items.length}</em></button>`;
          })
          .join("");
        $("#favCount").textContent = favs.length;
      }
      function allDocs() {
        let a = [];
        groups.forEach((g, gi) =>
          g.items.forEach((x, ii) => a.push({ g, gi, x, ii })),
        );
        return a;
      }
      function renderList(arr, title) {
        $("#listTitle").textContent = title;
        $("#addBtn").style.display = mode === "group" ? "block" : "none";
        let q = $("#q").value.trim().toLowerCase();
        if (q)
          arr = allDocs().filter((o) =>
            (o.x.title + " " + o.x.paragraphs.join(" "))
              .toLowerCase()
              .includes(q),
          );
        $("#items").innerHTML =
          arr
            .map(
              (o) =>
                `<div class="docitem ${o.gi === activeG && o.ii === activeI && mode !== "home" ? "on" : ""}" onclick="openDoc(${o.gi},${o.ii})"><b>${esc(o.x.title)}</b><small>${esc(o.g.title)} · ${esc(o.x.paragraphs.join(" ").slice(0, 55))}</small><button class="star ${favs.includes(id(o.gi, o.ii)) ? "on" : ""}" onclick="event.stopPropagation();toggleFav(${o.gi},${o.ii})">★</button></div>`,
            )
            .join("") || '<div class="empty">没有找到内容</div>';
      }
      function showHome() {
        setMode("home");
        renderNav();
        let docs = allDocs();
        renderList(
          recent
            .slice(0, 6)
            .map((k) => {
              let [g, i] = k.split("-").map(Number);
              return groups[g]?.items[i]
                ? { g: groups[g], gi: g, x: groups[g].items[i], ii: i }
                : null;
            })
            .filter(Boolean),
          "最近使用",
        );
        $("#main").innerHTML =
          `<div class="dashboard"><div class="hero"><h1>zhiyaunkefu 客服知识库</h1><p>统一管理客服话术、产品资料、售后规则和新人培训内容。</p></div><div class="stats"><div class="stat"><b>${groups.length}</b><span>知识分类</span></div><div class="stat"><b>${docs.length}</b><span>话术与文档</span></div><div class="stat"><b>${favs.length}</b><span>收藏内容</span></div><div class="stat"><b>${recent.length}</b><span>最近使用</span></div></div><div class="dashgrid"><div class="panel"><h3>常用入口</h3><div class="quick"><button onclick="jump('售前')">💬 售前话术<br><small>版本、价格、购买说明</small></button><button onclick="jump('售后 · on hold 触发')">⚠️ on hold<br><small>复核、申诉与后续方案</small></button><button onclick="jump('售后 · 处置动作')">💰 售后处置<br><small>退款、补差、升级</small></button><button onclick="jump('新人培训')">🎓 新人培训<br><small>阅读顺序与检查清单</small></button></div></div><div class="panel"><h3>售后退款计算器</h3><div class="calcgrid"><div class="field"><label>计算类型</label><select id="ctype" onchange="calc()"><option value="normal">普通售后：8%＋已用天数</option><option value="onhold">on hold：未使用净额五五分</option><option value="kyc">KYC：销售价减官方成本后按天</option></select></div><div class="field"><label>订单金额（元）</label><input id="price" type="number" value="499" oninput="calc()"></div><div class="field"><label>已使用天数</label><input id="days" type="number" min="0" max="30" value="10" oninput="calc()"></div><div class="field"><label>官方订阅成本（仅 KYC）</label><input id="cost" type="number" value="150" oninput="calc()"></div></div><div class="result">预计退款：<b id="amount">¥0.00</b><div id="formula"></div></div><div class="notice">内部核算工具。对客户仅告知最终金额，不直接展示内部计算公式。</div></div></div></div>`;
        calc();
      }
      function calc() {
        let p = +($("#price")?.value || 0),
          d = Math.max(0, Math.min(30, +($("#days")?.value || 0))),
          c = +($("#cost")?.value || 0),
          t = $("#ctype")?.value || "normal",
          a = 0,
          f = "";
        if (t === "normal") {
          a = p - p * 0.08 - (p / 30) * d;
          f = "订单价 − 8% 服务费 − 已用天数费用";
        } else if (t === "onhold") {
          a = (p * 0.46 * (30 - d)) / 30;
          f = "销售价 × 0.46 × 未使用天数 ÷ 30";
        } else {
          a = Math.max(0, ((p - c) * (30 - d)) / 30);
          f = "（销售价 − 官方订阅成本）× 未使用天数 ÷ 30";
        }
        a = Math.max(0, a);
        if ($("#amount")) $("#amount").textContent = "¥" + a.toFixed(2);
        if ($("#formula")) $("#formula").textContent = f;
      }
      function openGroup(gi) {
        activeG = gi;
        activeI = 0;
        setMode("group");
        renderNav();
        renderList(
          groups[gi].items.map((x, ii) => ({ g: groups[gi], gi, x, ii })),
          groups[gi].title,
        );
        groups[gi].items.length
          ? openDoc(gi, 0)
          : ($("#main").innerHTML =
              '<div class="empty">当前分类还没有内容。</div>');
      }
      function openDoc(gi, ii) {
        activeG = gi;
        activeI = ii;
        setMode("group");
        let k = id(gi, ii);
        recent = [k, ...recent.filter((x) => x !== k)].slice(0, 20);
        save();
        renderList(
          groups[gi].items.map((x, j) => ({ g: groups[gi], gi, x, ii: j })),
          groups[gi].title,
        );
        renderDoc();
      }
      function renderDoc() {
        let x = groups[activeG]?.items[activeI];
        if (!x) {
          $("#main").innerHTML = '<div class="empty">请选择内容</div>';
          return;
        }
        let text = x.paragraphs.join("\n\n");
        $("#main").innerHTML =
          `<div class="topbar"><div class="crumb">${esc(groups[activeG].title)} / ${editing ? "编辑内容" : "查看内容"}</div><div class="tools"><button class="btn" onclick="toggleFav(${activeG},${activeI})">${favs.includes(id(activeG, activeI)) ? "★ 已收藏" : "☆ 收藏"}</button><button class="btn" onclick="copyCurrent()">复制</button><button class="btn primary" onclick="toggleEdit()">${editing ? "完成编辑" : "编辑"}</button><button class="btn danger" onclick="deleteCurrent()">删除</button></div></div><div class="paper">${editing ? `<input class="titleinput" id="titleEdit" value="${esc(x.title)}"><textarea class="contentarea" id="bodyEdit">${esc(text)}</textarea>` : `<h1 style="margin:0;border-bottom:1px solid var(--line);padding-bottom:12px">${esc(x.title)}</h1><div class="readview">${esc(text)}</div>`}</div>`;
      }
      function toggleEdit() {
        if (editing) {
          let x = groups[activeG].items[activeI];
          x.title = $("#titleEdit").value.trim() || "未命名";
          x.paragraphs = $("#bodyEdit")
            .value.split(/\n\s*\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          save();
          toast("已保存");
        }
        editing = !editing;
        renderDoc();
        renderList(
          groups[activeG].items.map((x, j) => ({
            g: groups[activeG],
            gi: activeG,
            x,
            ii: j,
          })),
          groups[activeG].title,
        );
      }
      function copyCurrent() {
        let x = groups[activeG]?.items[activeI];
        if (x) copyText(x.paragraphs.join("\n\n"));
      }
      function toggleFav(g, i) {
        let k = id(g, i);
        favs = favs.includes(k) ? favs.filter((x) => x !== k) : [...favs, k];
        save();
        if (mode === "fav") showFavs();
        else if (mode === "group") renderDoc();
        toast(favs.includes(k) ? "已收藏" : "已取消收藏");
      }
      function showFavs() {
        setMode("fav");
        renderNav();
        let arr = favs
          .map((k) => {
            let [g, i] = k.split("-").map(Number);
            return groups[g]?.items[i]
              ? { g: groups[g], gi: g, x: groups[g].items[i], ii: i }
              : null;
          })
          .filter(Boolean);
        renderList(arr, "我的收藏");
        $("#main").innerHTML =
          '<div class="empty">从左侧选择收藏内容查看。</div>';
      }
      function showRecent() {
        setMode("recent");
        renderNav();
        let arr = recent
          .map((k) => {
            let [g, i] = k.split("-").map(Number);
            return groups[g]?.items[i]
              ? { g: groups[g], gi: g, x: groups[g].items[i], ii: i }
              : null;
          })
          .filter(Boolean);
        renderList(arr, "最近使用");
        $("#main").innerHTML =
          '<div class="empty">从左侧选择最近使用内容查看。</div>';
      }
      function addGroup() {
        let n = prompt("请输入分类名称", "新分类");
        if (!n) return;
        groups.push({ title: n, items: [] });
        save();
        openGroup(groups.length - 1);
      }
      function addItem() {
        if (mode !== "group") return;
        groups[activeG].items.push({
          title: "新内容",
          paragraphs: ["请在这里输入内容。"],
        });
        activeI = groups[activeG].items.length - 1;
        save();
        editing = true;
        openDoc(activeG, activeI);
      }
      function deleteCurrent() {
        if (!confirm("确定删除这条内容吗？")) return;
        groups[activeG].items.splice(activeI, 1);
        activeI = 0;
        save();
        openGroup(activeG);
      }
      function jump(name) {
        let i = groups.findIndex((g) => g.title === name);
        if (i >= 0) openGroup(i);
      }
      function download(name, text, type = "application/json") {
        let a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 500);
      }
      function exportData() {
        download("智源AI客服知识库备份.json", JSON.stringify(groups, null, 2));
      }
      function importData() {
        let i = document.createElement("input");
        i.type = "file";
        i.accept = ".json";
        i.onchange = () => {
          let r = new FileReader();
          r.onload = () => {
            try {
              groups = JSON.parse(r.result);
              save();
              showHome();
              toast("导入成功");
            } catch (e) {
              alert("文件格式不正确");
            }
          };
          r.readAsText(i.files[0]);
        };
        i.click();
      }
      function resetData() {
        if (confirm("确定恢复首版内容吗？当前修改将被覆盖。")) {
          groups = structuredClone(ORIGINAL_DATA);
          favs = [];
          recent = [];
          save();
          showHome();
        }
      }
      $("#q").addEventListener("input", () => {
        if ($("#q").value.trim()) renderList(allDocs(), "全局搜索");
        else if (mode === "home") showHome();
        else if (mode === "fav") showFavs();
        else if (mode === "recent") showRecent();
        else openGroup(activeG);
      });
      renderNav();
      showHome();
