const KEY = "zy_kb_system_v2",
        FKEY = "zy_kb_favs_v2",
        RKEY = "zy_kb_recent_v2",
        IKEY = "zy_kb_article_images_v2",
        DATA_VERSION_KEY = "zy_kb_default_data_version_v2",
        DATA_BACKUP_KEY = "zy_kb_system_v2_pre_document_pack_backup",
        DATA_VERSION = "document-pack-2026-07-22";
      const storedGroupsRaw = localStorage.getItem(KEY);
      const storedGroups = JSON.parse(storedGroupsRaw || "null");
      let needsDataVersionWrite =
        localStorage.getItem(DATA_VERSION_KEY) !== DATA_VERSION;
      let groups = storedGroups || structuredClone(ORIGINAL_DATA);
      if (storedGroups && needsDataVersionWrite) {
        if (!localStorage.getItem(DATA_BACKUP_KEY)) {
          localStorage.setItem(DATA_BACKUP_KEY, storedGroupsRaw);
        }
        groups = mergeOriginalData(storedGroups);
      }
      hydrateGroups();
      let favs = normalizeStoredIds(JSON.parse(localStorage.getItem(FKEY) || "[]"));
      let recent = normalizeStoredIds(JSON.parse(localStorage.getItem(RKEY) || "[]"));
      const storedArticleImages = JSON.parse(localStorage.getItem(IKEY) || "{}");
      let articleImageState =
        storedArticleImages &&
        typeof storedArticleImages === "object" &&
        !Array.isArray(storedArticleImages)
          ? storedArticleImages
          : {};
      let mode = "home",
        activeG = 0,
        activeI = 0,
        editing = false;
      const $ = (s) => document.querySelector(s);
      save();
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
      function renderMarkdownInline(raw) {
        return esc(raw)
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/__([^_]+)__/g, "<strong>$1</strong>")
          .replace(/~~([^~]+)~~/g, "<del>$1</del>");
      }
      function splitTableRow(line) {
        return line
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim());
      }
      function isTableDivider(line) {
        const cells = splitTableRow(line);
        return (
          cells.length > 0 &&
          cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
        );
      }
      function renderMarkdownTable(lines, start) {
        const headers = splitTableRow(lines[start]);
        const rows = [];
        let index = start + 2;
        while (index < lines.length && /^\s*\|/.test(lines[index])) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        const width = Math.max(
          headers.length,
          ...rows.map((row) => row.length),
        );
        const normalizeRow = (row) =>
          Array.from({ length: width }, (_, i) => row[i] || "");
        return {
          html: `<div class="md-table-wrap"><table><thead><tr>${normalizeRow(
            headers,
          )
            .map((cell) => `<th>${renderMarkdownInline(cell)}</th>`)
            .join("")}</tr></thead><tbody>${rows
            .map(
              (row) =>
                `<tr>${normalizeRow(row)
                  .map((cell) => `<td>${renderMarkdownInline(cell)}</td>`)
                  .join("")}</tr>`,
            )
            .join("")}</tbody></table></div>`,
          next: index,
        };
      }
      function isFlowDiagram(text) {
        return (
          /[┌┐└┘├┤┬┴┼│─▼▶]/.test(text) ||
          /^\s*[↓▼]\s*$/m.test(text)
        );
      }
      function splitFlowLine(line) {
        const cleaned = line
          .replace(/[┌┐└┘├┤┬┴┼─═]+/g, "  ")
          .replace(/[│]+/g, "  ")
          .replace(/[▼▶]+/g, "  ")
          .replace(/^\s*↓\s*$/, "")
          .replace(/\s+↓\s*/g, "  ")
          .trim();
        if (!/[\u3400-\u9fffA-Za-z0-9￥¥$%]/.test(cleaned)) return [];
        return cleaned
          .split(/\s{2,}/)
          .map((part) => part.trim())
          .filter(
            (part) =>
              part && /[\u3400-\u9fffA-Za-z0-9￥¥$%]/.test(part),
          );
      }
      function renderFlowDiagram(text) {
        const rows = text
          .split("\n")
          .map(splitFlowLine)
          .filter((parts) => parts.length);
        return `<div class="md-flow" aria-label="流程说明">${rows
          .map(
            (parts) =>
              `<div class="md-flow-row">${parts
                .map(
                  (part) =>
                    `<div class="md-flow-step">${renderMarkdownInline(part)}</div>`,
                )
                .join("")}</div>`,
          )
          .join("")}</div>`;
      }
      function renderMarkdownCodeBlock(text) {
        if (isFlowDiagram(text)) return renderFlowDiagram(text);
        return `<div class="md-code-block">${text
          .split("\n")
          .map((line) => {
            const list = line.match(/^\s*[-*+]\s+(.+)$/);
            if (list) {
              return `<div class="md-code-list-item">${renderMarkdownInline(list[1])}</div>`;
            }
            return line.trim()
              ? `<div>${renderMarkdownInline(line)}</div>`
              : '<div class="md-code-spacer"></div>';
          })
          .join("")}</div>`;
      }
      function markdownListMatch(line) {
        const match = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
        if (!match) return null;
        return {
          depth: Math.min(3, Math.floor(match[1].replace(/\t/g, "  ").length / 2)),
          ordered: /^\d/.test(match[2]),
          text: match[3],
        };
      }
      function renderMarkdown(text, articleTitle = "") {
        const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
        const out = [];
        let index = 0;
        let skippedTitle = false;
        while (index < lines.length) {
          const line = lines[index];
          if (!line.trim()) {
            index += 1;
            continue;
          }
          if (/^\s*```/.test(line)) {
            const code = [];
            index += 1;
            while (index < lines.length && !/^\s*```/.test(lines[index])) {
              code.push(lines[index]);
              index += 1;
            }
            if (index < lines.length) index += 1;
            out.push(renderMarkdownCodeBlock(code.join("\n").trim()));
            continue;
          }
          const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
          if (heading) {
            const headingText = heading[2].trim();
            if (
              !skippedTitle &&
              heading[1].length === 1 &&
              headingText === articleTitle
            ) {
              skippedTitle = true;
              index += 1;
              continue;
            }
            const level = Math.min(6, heading[1].length + 1);
            out.push(
              `<h${level}>${renderMarkdownInline(headingText)}</h${level}>`,
            );
            index += 1;
            continue;
          }
          if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
            out.push("<hr>");
            index += 1;
            continue;
          }
          if (
            /^\s*\|/.test(line) &&
            index + 1 < lines.length &&
            isTableDivider(lines[index + 1])
          ) {
            const table = renderMarkdownTable(lines, index);
            out.push(table.html);
            index = table.next;
            continue;
          }
          if (/^\s*>/.test(line)) {
            const quote = [];
            while (index < lines.length && /^\s*>/.test(lines[index])) {
              quote.push(lines[index].replace(/^\s*>\s?/, ""));
              index += 1;
            }
            out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
            continue;
          }
          const firstListItem = markdownListMatch(line);
          if (firstListItem) {
            const tag = firstListItem.ordered ? "ol" : "ul";
            const items = [];
            while (index < lines.length) {
              const item = markdownListMatch(lines[index]);
              if (!item || item.ordered !== firstListItem.ordered) break;
              items.push(
                `<li class="md-list-depth-${item.depth}">${renderMarkdownInline(item.text)}</li>`,
              );
              index += 1;
            }
            out.push(`<${tag}>${items.join("")}</${tag}>`);
            continue;
          }
          const paragraph = [line.trim()];
          index += 1;
          while (
            index < lines.length &&
            lines[index].trim() &&
            !/^\s*```/.test(lines[index]) &&
            !/^\s*(#{1,6})\s+/.test(lines[index]) &&
            !/^\s*>/.test(lines[index]) &&
            !markdownListMatch(lines[index]) &&
            !/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[index]) &&
            !(/^\s*\|/.test(lines[index]) &&
              index + 1 < lines.length &&
              isTableDivider(lines[index + 1]))
          ) {
            paragraph.push(lines[index].trim());
            index += 1;
          }
          out.push(`<p>${paragraph.map(renderMarkdownInline).join("<br>")}</p>`);
        }
        return out.join("");
      }
      function safeImageSrc(raw) {
        const src = String(raw ?? "").trim();
        if (!src || src.includes("\0") || src.startsWith("//")) return "";
        if (/^data:/i.test(src)) {
          return /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)
            ? src
            : "";
        }
        if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^https:/i.test(src)) {
          return "";
        }
        return src;
      }
      function normalizeImages(raw, fallbackAlt = "文章图片") {
        const images = Array.isArray(raw) ? raw : raw ? [raw] : [];
        return images
          .map((image, index) => {
            const record = typeof image === "string" ? { src: image } : image;
            if (!record || typeof record !== "object") return null;
            const src = safeImageSrc(record.src);
            if (!src) return null;
            return {
              image_id: String(record.image_id || record.id || ""),
              content_id: String(record.content_id || ""),
              source: String(record.source || ""),
              src,
              alt: String(record.alt || fallbackAlt),
              caption: String(record.caption || ""),
              file_name: String(record.file_name || `图片 ${index + 1}`),
            };
          })
          .filter(Boolean);
      }
      function ensureArticleImageState(contentId) {
        const current = articleImageState[contentId];
        if (!current || typeof current !== "object" || Array.isArray(current)) {
          articleImageState[contentId] = {};
        }
        const state = articleImageState[contentId];
        if (!Array.isArray(state.uploads)) state.uploads = [];
        if (!Array.isArray(state.order)) state.order = [];
        if (!Array.isArray(state.hidden)) state.hidden = [];
        if (!state.captions || typeof state.captions !== "object") {
          state.captions = {};
        }
        return state;
      }
      function updateArticleImageState(contentId, updater) {
        const existed = Object.prototype.hasOwnProperty.call(
          articleImageState,
          contentId,
        );
        const previous = existed
          ? structuredClone(articleImageState[contentId])
          : null;
        const state = ensureArticleImageState(contentId);
        updater(state);
        try {
          localStorage.setItem(IKEY, JSON.stringify(articleImageState));
          return true;
        } catch (error) {
          if (existed) articleImageState[contentId] = previous;
          else delete articleImageState[contentId];
          alert("图片保存失败，可能是浏览器本地存储空间不足。请减少图片数量或尺寸后重试。");
          return false;
        }
      }
      function getArticleImages(article, g, i) {
        if (!article) return [];
        const contentId = article.content_id || id(g, i);
        const official = normalizeImages(article.images, article.title).map(
          (image, index) => ({
            ...image,
            image_id:
              image.image_id || `${contentId}_official_${index + 1}`,
            content_id: contentId,
            source: "official",
          }),
        );
        const rawState = articleImageState[contentId];
        if (!rawState || typeof rawState !== "object") return official;
        const uploads = normalizeImages(rawState.uploads, article.title)
          .filter(
            (image) => !image.content_id || image.content_id === contentId,
          )
          .map((image, index) => ({
            ...image,
            image_id:
              image.image_id || `${contentId}_upload_legacy_${index + 1}`,
            content_id: contentId,
            source: "upload",
          }));
        const hidden = new Set(Array.isArray(rawState.hidden) ? rawState.hidden : []);
        const captions =
          rawState.captions && typeof rawState.captions === "object"
            ? rawState.captions
            : {};
        const unique = new Map();
        [...official, ...uploads].forEach((image) => {
          if (hidden.has(image.image_id) || unique.has(image.image_id)) return;
          unique.set(image.image_id, {
            ...image,
            caption: Object.prototype.hasOwnProperty.call(
              captions,
              image.image_id,
            )
              ? String(captions[image.image_id])
              : image.caption,
          });
        });
        const order = Array.isArray(rawState.order) ? rawState.order : [];
        const positions = new Map(order.map((imageId, index) => [imageId, index]));
        return [...unique.values()].sort((a, b) => {
          const aPosition = positions.has(a.image_id)
            ? positions.get(a.image_id)
            : Number.MAX_SAFE_INTEGER;
          const bPosition = positions.has(b.image_id)
            ? positions.get(b.image_id)
            : Number.MAX_SAFE_INTEGER;
          return aPosition - bPosition;
        });
      }
      function renderArticleImages(raw, title) {
        const images = normalizeImages(raw, title);
        if (!images.length) return "";
        return `<div class="article-images" aria-label="文章图片">${images
          .map(
            (image, index) =>
              `<figure class="article-image"><button type="button" class="article-image-button" onclick="openImage(${activeG},${activeI},${index})" aria-label="查看大图：${esc(image.alt)}"><img src="${esc(image.src)}" alt="${esc(image.alt)}" loading="lazy" onerror="this.closest('.article-image').remove()"></button>${image.caption ? `<figcaption>${esc(image.caption)}</figcaption>` : ""}</figure>`,
          )
          .join("")}</div>`;
      }
      function openImage(g, i, imageIndex) {
        const article = groups[g]?.items?.[i];
        const image = getArticleImages(article, g, i)[imageIndex];
        if (!image) return;
        closeImageViewer();
        const viewer = document.createElement("div");
        viewer.className = "image-viewer";
        viewer.setAttribute("role", "dialog");
        viewer.setAttribute("aria-modal", "true");
        viewer.setAttribute("aria-label", image.alt);
        viewer.innerHTML = `<button type="button" class="image-viewer-close" onclick="closeImageViewer()" aria-label="关闭图片">×</button><div class="image-viewer-content"><img src="${esc(image.src)}" alt="${esc(image.alt)}">${image.caption ? `<div>${esc(image.caption)}</div>` : ""}</div>`;
        viewer.addEventListener("click", (event) => {
          if (event.target === viewer) closeImageViewer();
        });
        document.body.appendChild(viewer);
        document.body.classList.add("viewing-image");
        viewer.querySelector(".image-viewer-close")?.focus();
      }
      function renderImageManager(g, i) {
        const article = groups[g]?.items?.[i];
        if (!article) return "";
        const contentId = getContentId(g, i);
        const images = getArticleImages(article, g, i);
        return `<section class="image-manager"><div class="image-manager-head"><div><h2>文章图片</h2><p>图片独立保存，并与当前文章 ID <code>${esc(contentId)}</code> 关联。</p></div><label class="btn image-upload-button">选择图片<input id="articleImageUpload" class="image-upload-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onchange="addArticleImages(event)"></label></div>${images.length ? `<div class="image-manager-grid">${images
          .map(
            (image, index) =>
              `<article class="image-manager-card"><button type="button" class="image-manager-preview" onclick="openImage(${g},${i},${index})" aria-label="放大图片：${esc(image.alt)}"><img src="${esc(image.src)}" alt="${esc(image.alt)}" loading="lazy"></button><div class="image-manager-meta"><span>${image.source === "official" ? "正式资料图片" : "浏览器上传"}</span><small>${index + 1} / ${images.length}</small></div><label>图片说明<input type="text" value="${esc(image.caption)}" placeholder="可填写图片说明" onchange="updateImageCaption(${g},${i},${index},this.value)"></label><div class="image-manager-actions"><button type="button" class="btn" onclick="moveArticleImage(${g},${i},${index},-1)" ${index === 0 ? "disabled" : ""}>上移</button><button type="button" class="btn" onclick="moveArticleImage(${g},${i},${index},1)" ${index === images.length - 1 ? "disabled" : ""}>下移</button><button type="button" class="btn danger" onclick="deleteArticleImage(${g},${i},${index})">删除</button></div></article>`,
          )
          .join("")}</div>` : '<div class="image-manager-empty">暂无图片。点击“选择图片”可一次添加多张。</div>'}</section>`;
      }
      function createImageId(contentId) {
        const random =
          globalThis.crypto?.randomUUID?.().replace(/-/g, "") ||
          Math.random().toString(36).slice(2) + Date.now().toString(36);
        return `${contentId}_image_${random}`;
      }
      function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(new Error("read failed"));
          reader.readAsDataURL(file);
        });
      }
      function optimizeImageDataUrl(dataUrl, file) {
        if (file.size <= 700 * 1024 || file.type === "image/gif") {
          return Promise.resolve(dataUrl);
        }
        return new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            const maxSide = 1600;
            const scale = Math.min(
              1,
              maxSide / Math.max(image.naturalWidth, image.naturalHeight),
            );
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const context = canvas.getContext("2d");
            if (!context) {
              resolve(dataUrl);
              return;
            }
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const optimized = canvas.toDataURL("image/webp", 0.84);
            resolve(optimized.length < dataUrl.length ? optimized : dataUrl);
          };
          image.onerror = () => resolve(dataUrl);
          image.src = dataUrl;
        });
      }
      async function addArticleImages(event) {
        const input = event.currentTarget;
        const files = [...(input.files || [])];
        input.value = "";
        if (!files.length) return;
        const allowed = /^(image\/(png|jpeg|gif|webp))$/i;
        if (files.some((file) => !allowed.test(file.type))) {
          alert("仅支持 PNG、JPG、GIF 和 WebP 图片。");
          return;
        }
        if (files.some((file) => file.size > 12 * 1024 * 1024)) {
          alert("单张原图不能超过 12MB，请压缩后重试。");
          return;
        }
        const contentId = ensureStableContentId(activeG, activeI);
        const article = groups[activeG]?.items?.[activeI];
        if (!article) return;
        try {
          const uploads = [];
          for (const file of files) {
            const raw = await readFileAsDataUrl(file);
            const src = await optimizeImageDataUrl(raw, file);
            if (!safeImageSrc(src) || src.length > 2.5 * 1024 * 1024) {
              throw new Error("image too large");
            }
            uploads.push({
              image_id: createImageId(contentId),
              content_id: contentId,
              source: "upload",
              src,
              alt: file.name || article.title,
              caption: "",
              file_name: file.name || "浏览器上传图片",
            });
          }
          const currentOrder = getArticleImages(
            article,
            activeG,
            activeI,
          ).map((image) => image.image_id);
          const saved = updateArticleImageState(contentId, (state) => {
            state.uploads.push(...uploads);
            state.order = [
              ...currentOrder,
              ...uploads.map((image) => image.image_id),
            ];
          });
          if (!saved) return;
          renderDoc();
          toast(`已添加 ${uploads.length} 张图片`);
        } catch (error) {
          alert("图片处理失败或压缩后仍过大，请换用尺寸更小的图片。");
        }
      }
      function updateImageCaption(g, i, imageIndex, caption) {
        const article = groups[g]?.items?.[i];
        const image = getArticleImages(article, g, i)[imageIndex];
        if (!image) return;
        updateArticleImageState(image.content_id, (state) => {
          state.captions[image.image_id] = String(caption || "");
        });
      }
      function moveArticleImage(g, i, imageIndex, direction) {
        const article = groups[g]?.items?.[i];
        const images = getArticleImages(article, g, i);
        const target = imageIndex + direction;
        if (!images[imageIndex] || target < 0 || target >= images.length) return;
        [images[imageIndex], images[target]] = [images[target], images[imageIndex]];
        const contentId = images[0].content_id;
        const saved = updateArticleImageState(contentId, (state) => {
          state.order = images.map((image) => image.image_id);
        });
        if (saved) renderDoc();
      }
      function deleteArticleImage(g, i, imageIndex) {
        const article = groups[g]?.items?.[i];
        const images = getArticleImages(article, g, i);
        const image = images[imageIndex];
        if (!image || !confirm("确定删除这张图片吗？正文不会受到影响。")) return;
        const saved = updateArticleImageState(image.content_id, (state) => {
          if (image.source === "official") {
            if (!state.hidden.includes(image.image_id)) {
              state.hidden.push(image.image_id);
            }
          } else {
            state.uploads = state.uploads.filter(
              (item) => item.image_id !== image.image_id,
            );
          }
          state.order = state.order.filter(
            (imageId) => imageId !== image.image_id,
          );
          delete state.captions[image.image_id];
        });
        if (saved) {
          renderDoc();
          toast("图片已删除");
        }
      }
      function closeImageViewer() {
        document.querySelector(".image-viewer")?.remove();
        document.body.classList.remove("viewing-image");
      }
      function id(g, i) {
        return g + "-" + i;
      }
      function isStableContentId(value) {
        return typeof value === "string" && value.startsWith("content_");
      }
      function createContentId() {
        let contentId = "";
        do {
          const random =
            globalThis.crypto?.randomUUID?.().replace(/-/g, "") ||
            Math.random().toString(36).slice(2) + Date.now().toString(36);
          contentId = `content_user_${random}`;
        } while (allDocs().some(({ x }) => x.content_id === contentId));
        return contentId;
      }
      function ensureStableContentId(g, i) {
        const article = groups[g]?.items?.[i];
        if (!article) return "";
        if (isStableContentId(article.content_id)) return article.content_id;
        const oldId = article.content_id || id(g, i);
        const contentId = createContentId();
        article.content_id = contentId;
        favs = favs.map((value) => (value === oldId ? contentId : value));
        recent = recent.map((value) => (value === oldId ? contentId : value));
        if (Object.prototype.hasOwnProperty.call(articleImageState, oldId)) {
          articleImageState[contentId] = articleImageState[oldId];
          if (Array.isArray(articleImageState[contentId]?.uploads)) {
            articleImageState[contentId].uploads.forEach((image) => {
              image.content_id = contentId;
            });
          }
          delete articleImageState[oldId];
          localStorage.setItem(IKEY, JSON.stringify(articleImageState));
        }
        save();
        return contentId;
      }
      function findMatchIndex(list, candidate, fallbackIndex, used) {
        let index = -1;
        if (candidate?.category_id) {
          index = list.findIndex(
            (item, i) =>
              !used.has(i) && item?.category_id === candidate.category_id,
          );
        }
        if (index < 0 && candidate?.content_id) {
          index = list.findIndex(
            (item, i) =>
              !used.has(i) && item?.content_id === candidate.content_id,
          );
        }
        if (index < 0 && candidate?.title) {
          index = list.findIndex(
            (item, i) => !used.has(i) && item?.title === candidate.title,
          );
        }
        if (
          index < 0 &&
          Number.isInteger(fallbackIndex) &&
          list[fallbackIndex] &&
          !used.has(fallbackIndex)
        ) {
          index = fallbackIndex;
        }
        return index;
      }
      function mergeGroupItems(storedGroup, baseGroup) {
        const baseItems = baseGroup.items || [];
        const usedBaseItems = new Set();
        const items = (storedGroup.items || []).map((storedItem, ii) => {
          const baseIndex = findMatchIndex(
            baseItems,
            storedItem,
            storedItem?.content_id ? null : ii,
            usedBaseItems,
          );
          if (baseIndex < 0) return structuredClone(storedItem);
          usedBaseItems.add(baseIndex);
          const baseItem = baseItems[baseIndex];
          return {
            ...structuredClone(baseItem),
            ...storedItem,
            content_id: baseItem.content_id || storedItem.content_id,
          };
        });
        baseItems.forEach((baseItem, ii) => {
          if (!usedBaseItems.has(ii)) items.push(structuredClone(baseItem));
        });
        return items;
      }
      function mergeOriginalData(stored) {
        if (!Array.isArray(stored)) return structuredClone(ORIGINAL_DATA);
        const usedBaseGroups = new Set();
        const merged = stored.map((storedGroup, gi) => {
          const baseIndex = findMatchIndex(
            ORIGINAL_DATA,
            storedGroup,
            storedGroup?.category_id ? null : gi,
            usedBaseGroups,
          );
          if (baseIndex < 0) return structuredClone(storedGroup);
          usedBaseGroups.add(baseIndex);
          const baseGroup = ORIGINAL_DATA[baseIndex];
          return {
            ...structuredClone(baseGroup),
            ...storedGroup,
            category_id: baseGroup.category_id || storedGroup.category_id,
            items: mergeGroupItems(storedGroup, baseGroup),
          };
        });
        ORIGINAL_DATA.forEach((baseGroup, gi) => {
          if (!usedBaseGroups.has(gi)) merged.push(structuredClone(baseGroup));
        });
        return merged;
      }
      function hydrateGroups() {
        groups = groups.map((g, gi) => {
          const baseGroup =
            ORIGINAL_DATA.find(
              (candidate) =>
                g.category_id && candidate.category_id === g.category_id,
            ) ||
            ORIGINAL_DATA.find((candidate) => candidate.title === g.title) ||
            {};
          const baseItems = baseGroup.items || [];
          return {
            ...baseGroup,
            ...g,
            category_id:
              g.category_id || baseGroup.category_id || `group_${gi}`,
            items: (g.items || []).map((x, ii) => {
              const baseItem =
                baseItems.find(
                  (candidate) =>
                    x.content_id && candidate.content_id === x.content_id,
                ) ||
                baseItems.find((candidate) => candidate.title === x.title) ||
                (!x.content_id ? baseItems[ii] : null) ||
                {};
              return {
                ...baseItem,
                ...x,
                content_id: x.content_id || baseItem.content_id || id(gi, ii),
              };
            }),
          };
        });
      }
      function getContentId(g, i) {
        let x = groups[g]?.items?.[i];
        return x?.content_id || id(g, i);
      }
      function normalizeStoredId(raw) {
        if (typeof raw !== "string") return null;
        const value = raw.trim();
        if (!value) return null;
        if (value.startsWith("content_")) return value;
        if (/^\d+-\d+$/.test(value)) {
          let [g, i] = value.split("-").map(Number);
          let x = groups[g]?.items?.[i];
          return x?.content_id || value;
        }
        return null;
      }
      function normalizeStoredIds(arr) {
        if (!Array.isArray(arr)) return [];
        let out = [];
        let seen = new Set();
        arr.forEach((raw) => {
          let next = normalizeStoredId(raw);
          if (!next || seen.has(next)) return;
          seen.add(next);
          out.push(next);
        });
        return out;
      }
      function resolveStoredIdRecord(k) {
        let normalized = normalizeStoredId(k);
        if (!normalized) return null;
        if (normalized.startsWith("content_")) {
          for (let g = 0; g < groups.length; g++) {
            for (let i = 0; i < groups[g].items.length; i++) {
              let x = groups[g].items[i];
              if (x?.content_id === normalized) {
                return { g: groups[g], gi: g, x, ii: i };
              }
            }
          }
          return null;
        }
        if (/^\d+-\d+$/.test(normalized)) {
          let [g, i] = normalized.split("-").map(Number);
          let x = groups[g]?.items?.[i];
          return x ? { g: groups[g], gi: g, x, ii: i } : null;
        }
        return null;
      }
      function toast(s) {
        let t = $("#toast");
        t.textContent = s;
        t.classList.add("show");
        clearTimeout(window.tt);
        window.tt = setTimeout(() => t.classList.remove("show"), 1200);
      }
      function save() {
        hydrateGroups();
        favs = normalizeStoredIds(favs);
        recent = normalizeStoredIds(recent);
        localStorage.setItem(KEY, JSON.stringify(groups));
        localStorage.setItem(FKEY, JSON.stringify(favs));
        localStorage.setItem(RKEY, JSON.stringify(recent));
        if (needsDataVersionWrite) {
          localStorage.setItem(DATA_VERSION_KEY, DATA_VERSION);
          needsDataVersionWrite = false;
        }
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
      
      
      function showHome() {
        setMode("home");
        renderNav();
        let docs = allDocs();
        renderList(
          recent
            .slice(0, 6)
            .map((k) => resolveStoredIdRecord(k))
            .filter(Boolean),
          "最近使用",
        );
        $("#main").innerHTML =
          `<div class="dashboard"><div class="hero"><h1>智源客服知识库</h1><p>统一管理客服话术、产品资料、售后规则和新人培训内容。</p></div><div class="stats"><div class="stat"><b>${groups.length}</b><span>知识分类</span></div><div class="stat"><b>${docs.length}</b><span>话术与文档</span></div><div class="stat"><b>${favs.length}</b><span>收藏内容</span></div><div class="stat"><b>${recent.length}</b><span>最近使用</span></div></div><div class="dashgrid"><div class="panel"><h3>常用入口</h3><div class="quick"><button onclick="jump('售前')">💬 售前话术<br><small>版本、价格、购买说明</small></button><button onclick="jump('售后 · on hold 触发')">⚠️ on hold<br><small>复核、申诉与后续方案</small></button><button onclick="jump('售后 · 处置动作')">💰 售后处置<br><small>退款、补差、升级</small></button><button onclick="jump('新人培训')">🎓 新人培训<br><small>阅读顺序与检查清单</small></button></div></div><div class="panel"><h3>售后退款计算器</h3><div class="calcgrid"><div class="field"><label>计算类型</label><select id="ctype" onchange="calc()"><option value="normal">普通售后：8%＋已用天数</option><option value="onhold">on hold：未使用净额五五分</option><option value="kyc">KYC：销售价减官方成本后按天</option></select></div><div class="field"><label>订单金额（元）</label><input id="price" type="number" value="499" oninput="calc()"></div><div class="field"><label>已使用天数</label><input id="days" type="number" min="0" max="30" value="10" oninput="calc()"></div><div class="field"><label>官方订阅成本（仅 KYC）</label><input id="cost" type="number" value="150" oninput="calc()"></div></div><div class="result">预计退款：<b id="amount">¥0.00</b><div id="formula"></div></div><div class="notice">内部核算工具。对客户仅告知最终金额，不直接展示内部计算公式。</div></div></div></div>`;
        calc();
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
        let k = getContentId(gi, ii);
        recent = [k, ...recent.filter((x) => x !== k)].slice(0, 20);
        save();
        renderList(
          groups[gi].items.map((x, j) => ({ g: groups[gi], gi, x, ii: j })),
          groups[gi].title,
        );
        renderDoc();
      }
      function renderDoc() {
        if (editing) ensureStableContentId(activeG, activeI);
        let x = groups[activeG]?.items[activeI];
        if (!x) {
          $("#main").innerHTML = '<div class="empty">请选择内容</div>';
          return;
        }
        let text = x.paragraphs.join("\n\n");
        let images = renderArticleImages(
          getArticleImages(x, activeG, activeI),
          x.title,
        );
        let body =
          x.format === "markdown"
            ? `<div class="markdown-body">${renderMarkdown(text, x.title)}</div>`
            : `<div class="readview">${esc(text)}</div>`;
        $("#main").innerHTML =
          `<div class="topbar"><div class="crumb">${esc(groups[activeG].title)} / ${editing ? "编辑内容" : "查看内容"}</div><div class="tools"><button class="btn" onclick="toggleFav(${activeG},${activeI})">${favs.includes(getContentId(activeG, activeI)) ? "★ 已收藏" : "☆ 收藏"}</button><button class="btn" onclick="copyCurrent()">复制</button><button class="btn primary" onclick="toggleEdit()">${editing ? "完成编辑" : "编辑"}</button><button class="btn danger" onclick="deleteCurrent()">删除</button></div></div><div class="paper">${editing ? `<input class="titleinput" id="titleEdit" value="${esc(x.title)}"><textarea class="contentarea" id="bodyEdit">${esc(text)}</textarea>${renderImageManager(activeG, activeI)}` : `<h1 style="margin:0;border-bottom:1px solid var(--line);padding-bottom:12px">${esc(x.title)}</h1>${images}${body}`}</div>`;
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
        let k = getContentId(g, i);
        favs = favs.includes(k) ? favs.filter((x) => x !== k) : [...favs, k];
        save();
        if (mode === "fav") showFavs();
        else if (mode === "group") renderDoc();
        toast(favs.includes(k) ? "已收藏" : "已取消收藏");
      }
      function showFavs() {
        setMode("fav");
        renderNav();
        let arr = favs.map((k) => resolveStoredIdRecord(k)).filter(Boolean);
        renderList(arr, "我的收藏");
        $("#main").innerHTML =
          '<div class="empty">从左侧选择收藏内容查看。</div>';
      }
      function showRecent() {
        setMode("recent");
        renderNav();
        let arr = recent.map((k) => resolveStoredIdRecord(k)).filter(Boolean);
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
          content_id: createContentId(),
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
        const exportGroups = structuredClone(groups);
        exportGroups.forEach((group, gi) => {
          group.items.forEach((article, ii) => {
            const images = getArticleImages(groups[gi]?.items?.[ii], gi, ii);
            if (!images.length) return;
            article.images = images.map((image) => ({
              image_id: image.image_id,
              content_id: image.content_id,
              src: image.src,
              alt: image.alt,
              caption: image.caption,
              file_name: image.file_name,
            }));
          });
        });
        download(
          "智源AI客服知识库备份.json",
          JSON.stringify(exportGroups, null, 2),
        );
      }
      function importData() {
        let i = document.createElement("input");
        i.type = "file";
        i.accept = ".json";
        i.onchange = () => {
          let r = new FileReader();
          r.onload = () => {
            try {
              const importedGroups = JSON.parse(r.result);
              if (!Array.isArray(importedGroups)) throw new Error("invalid data");
              groups = mergeOriginalData(importedGroups);
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
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeImageViewer();
      });
      renderNav();
      showHome();
