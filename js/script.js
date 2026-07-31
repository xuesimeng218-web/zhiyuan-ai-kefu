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
      const GALLERY_PRODUCTS = [
        "ChatGPT",
        "Claude",
        "Gemini",
        "Grok",
        "Cursor",
        "Perplexity",
        "其他产品",
      ];
      const PRICE_GALLERY_ENTRY_ID = "price-gallery";
      const galleryViewState = {
        query: "",
        product: "all",
        status: "all",
        sort: "custom",
      };
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
        return `<section class="image-manager" data-content-id="${esc(contentId)}" tabindex="0" onpaste="pasteArticleImages(event)" aria-label="文章图片管理区，可粘贴图片"><div class="image-manager-head"><div><h2>文章图片 / 添加图片</h2><p>图片独立保存，并与当前文章 ID <code>${esc(contentId)}</code> 关联。</p><p class="image-paste-hint">点击此区域后按 Command+V / Ctrl+V，可直接粘贴从微信复制的图片。</p></div><label class="btn image-upload-button">添加图片<input class="image-upload-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onchange="addArticleImages(event)"></label></div>${images.length ? `<div class="image-manager-grid">${images
          .map(
            (image, index) =>
              `<article class="image-manager-card"><button type="button" class="image-manager-preview" onclick="openImage(${g},${i},${index})" aria-label="放大图片：${esc(image.alt)}"><img src="${esc(image.src)}" alt="${esc(image.alt)}" loading="lazy"></button><div class="image-manager-meta"><span>${image.source === "official" ? "正式资料图片" : "浏览器上传"}</span><small>${index + 1} / ${images.length}</small></div><label>图片说明<input type="text" value="${esc(image.caption)}" placeholder="可填写图片说明" oninput="scheduleImageCaption(${g},${i},${index},this.value)" onblur="flushImageCaption(${g},${i},${index},this.value)"></label><div class="image-manager-actions"><button type="button" class="btn" onclick="moveArticleImage(${g},${i},${index},-1)" ${index === 0 ? "disabled" : ""}>上移</button><button type="button" class="btn" onclick="moveArticleImage(${g},${i},${index},1)" ${index === images.length - 1 ? "disabled" : ""}>下移</button><button type="button" class="btn danger" onclick="deleteArticleImage(${g},${i},${index})">删除</button></div></article>`,
          )
          .join("")}</div>` : '<div class="image-manager-empty">暂无图片。可选择图片，或点击此区域后直接粘贴图片。</div>'}</section>`;
      }
      function findImageManager(contentId) {
        return [...document.querySelectorAll(".image-manager")].find(
          (manager) => manager.dataset.contentId === contentId,
        );
      }
      function refreshImageManager(contentId, focusManager = false) {
        const record = resolveStoredIdRecord(contentId);
        const manager = findImageManager(contentId);
        if (!record || !manager) return;
        manager.outerHTML = renderImageManager(record.gi, record.ii);
        if (focusManager) {
          findImageManager(contentId)?.focus();
        }
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
        const targetLength = 650 * 1024;
        if (file.type === "image/gif" && dataUrl.length <= targetLength) {
          return Promise.resolve(dataUrl);
        }
        return new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            const maxSide = 1600;
            const initialScale = Math.min(
              1,
              maxSide / Math.max(image.naturalWidth, image.naturalHeight),
            );
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (!context) {
              resolve(dataUrl);
              return;
            }
            const qualities = [0.84, 0.72, 0.6];
            let best = dataUrl;
            for (let attempt = 0; attempt < 12; attempt += 1) {
              const shrink = Math.pow(0.82, Math.floor(attempt / 3));
              const scale = initialScale * shrink;
              canvas.width = Math.max(
                1,
                Math.round(image.naturalWidth * scale),
              );
              canvas.height = Math.max(
                1,
                Math.round(image.naturalHeight * scale),
              );
              context.clearRect(0, 0, canvas.width, canvas.height);
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
              const candidate = canvas.toDataURL(
                "image/webp",
                qualities[attempt % qualities.length],
              );
              if (candidate.length < best.length) best = candidate;
              if (candidate.length <= targetLength) {
                resolve(candidate.length < dataUrl.length ? candidate : dataUrl);
                return;
              }
            }
            resolve(best);
          };
          image.onerror = () => resolve(dataUrl);
          image.src = dataUrl;
        });
      }
      async function processArticleImageFiles(rawFiles, contentId) {
        const files = [...rawFiles];
        if (!files.length) return;
        if (!isStableContentId(contentId)) return;
        const record = resolveStoredIdRecord(contentId);
        const article = record?.x;
        if (!article || article.content_id !== contentId) {
          alert("当前文章已发生变化，请重新打开文章后再添加图片。");
          return;
        }
        const allowed = /^(image\/(png|jpeg|gif|webp))$/i;
        if (files.some((file) => !allowed.test(file.type))) {
          alert("仅支持 PNG、JPG、GIF 和 WebP 图片。");
          return;
        }
        if (files.some((file) => file.size > 12 * 1024 * 1024)) {
          alert("单张原图不能超过 12MB，请压缩后重试。");
          return;
        }
        try {
          const uploads = [];
          for (const file of files) {
            const raw = await readFileAsDataUrl(file);
            const src = await optimizeImageDataUrl(raw, file);
            if (!safeImageSrc(src) || src.length > 900 * 1024) {
              throw new Error("image too large");
            }
            uploads.push({
              image_id: createImageId(contentId),
              content_id: contentId,
              source: "upload",
              src,
              alt: file.name || article.title,
              caption: "",
              file_name: file.name || "剪贴板图片",
            });
          }
          const latestRecord = resolveStoredIdRecord(contentId);
          if (!latestRecord || latestRecord.x.content_id !== contentId) {
            throw new Error("article changed");
          }
          const currentOrder = getArticleImages(
            latestRecord.x,
            latestRecord.gi,
            latestRecord.ii,
          ).map((image) => image.image_id);
          const saved = updateArticleImageState(contentId, (state) => {
            state.uploads.push(...uploads);
            state.order = [
              ...currentOrder,
              ...uploads.map((image) => image.image_id),
            ];
          });
          if (!saved) return;
          refreshImageManager(contentId, true);
          toast(`已添加并压缩 ${uploads.length} 张图片`);
        } catch (error) {
          alert("图片处理失败或压缩后仍过大，请换用尺寸更小的图片。");
        }
      }
      async function addArticleImages(event) {
        const input = event.currentTarget;
        const files = [...(input.files || [])];
        const contentId = input.closest(".image-manager")?.dataset.contentId;
        input.value = "";
        await processArticleImageFiles(files, contentId);
      }
      async function pasteArticleImages(event) {
        const contentId = event.currentTarget.dataset.contentId;
        const itemFiles = [...(event.clipboardData?.items || [])]
          .filter(
            (item) =>
              item.kind === "file" && /^image\//i.test(item.type || ""),
          )
          .map((item) => item.getAsFile())
          .filter(Boolean);
        const clipboardFiles = [...(event.clipboardData?.files || [])].filter(
          (file) => /^image\//i.test(file.type || ""),
        );
        const files = itemFiles.length ? itemFiles : clipboardFiles;
        if (!files.length) return;
        event.preventDefault();
        await processArticleImageFiles(files, contentId);
      }
      const imageCaptionTimers = new Map();
      function persistImageCaption(image, caption) {
        if (!image) return;
        updateArticleImageState(image.content_id, (state) => {
          state.captions[image.image_id] = String(caption || "");
        });
      }
      function scheduleImageCaption(g, i, imageIndex, caption) {
        const article = groups[g]?.items?.[i];
        const image = getArticleImages(article, g, i)[imageIndex];
        if (!image) return;
        clearTimeout(imageCaptionTimers.get(image.image_id));
        imageCaptionTimers.set(
          image.image_id,
          setTimeout(() => {
            imageCaptionTimers.delete(image.image_id);
            persistImageCaption(image, caption);
          }, 250),
        );
      }
      function flushImageCaption(g, i, imageIndex, caption) {
        const article = groups[g]?.items?.[i];
        const image = getArticleImages(article, g, i)[imageIndex];
        if (!image) return;
        clearTimeout(imageCaptionTimers.get(image.image_id));
        imageCaptionTimers.delete(image.image_id);
        persistImageCaption(image, caption);
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
        if (saved) refreshImageManager(contentId);
      }
      function deleteArticleImage(g, i, imageIndex) {
        const article = groups[g]?.items?.[i];
        const images = getArticleImages(article, g, i);
        const image = images[imageIndex];
        if (!image || !confirm("确定删除这张图片吗？正文不会受到影响。")) return;
        clearTimeout(imageCaptionTimers.get(image.image_id));
        imageCaptionTimers.delete(image.image_id);
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
          refreshImageManager(image.content_id);
          toast("图片已删除");
        }
      }
      function closeImageViewer() {
        document.querySelector(".image-viewer")?.remove();
        document.body.classList.remove("viewing-image");
      }
      function isProductCenterGroup(group) {
        return String(group?.category_id || "").trim() === "products";
      }
      function renderGallerySystemEntry(gi) {
        const activeClass = mode === "gallery" ? "on" : "";
        return `<button type="button" class="docitem gallery-system-entry ${activeClass}" data-system-entry="${PRICE_GALLERY_ENTRY_ID}" onclick="openPriceGallery(${gi})"><b>价格图素材库 <span>图库</span></b><small>集中管理 ChatGPT、Claude、Gemini、Grok、Cursor、Perplexity 等产品价格图</small></button>`;
      }
      function renderGroupList(gi) {
        const group = groups[gi];
        if (!group) return;
        renderList(
          group.items.map((x, ii) => ({ g: group, gi, x, ii })),
          group.title,
        );
        if (!isProductCenterGroup(group) || $("#q").value.trim()) return;
        $("#items").innerHTML =
          renderGallerySystemEntry(gi) + $("#items").innerHTML;
      }
      function firstGalleryValue(...values) {
        const value = values.find(
          (candidate) =>
            candidate !== undefined &&
            candidate !== null &&
            String(candidate).trim(),
        );
        return value === undefined ? "" : String(value).trim();
      }
      function getGalleryRawImage(article, contentId, image) {
        const official = Array.isArray(article?.images)
          ? article.images
          : article?.images
            ? [article.images]
            : [];
        const uploads = Array.isArray(articleImageState[contentId]?.uploads)
          ? articleImageState[contentId].uploads
          : [];
        return [...official, ...uploads].find((candidate) => {
          const record =
            typeof candidate === "string" ? { src: candidate } : candidate;
          if (!record || typeof record !== "object") return false;
          const candidateId = String(record.image_id || record.id || "");
          return (
            (candidateId && candidateId === image.image_id) ||
            safeImageSrc(record.src) === image.src
          );
        }) || {};
      }
      function normalizeGalleryProduct(raw, fallbackText = "") {
        const detectProducts = (value) => {
          const text = String(value || "").toLowerCase();
          return [
            ["ChatGPT", /chatgpt|openai|\bgpt\b/],
            ["Claude", /claude|anthropic/],
            ["Gemini", /gemini|google ai/],
            ["Grok", /grok|xai|x\.ai/],
            ["Cursor", /cursor/],
            ["Perplexity", /perplexity/],
          ]
            .filter(([, pattern]) => pattern.test(text))
            .map(([product]) => product);
        };
        const explicitProducts = detectProducts(raw);
        if (explicitProducts.length === 1) return explicitProducts[0];
        if (explicitProducts.length > 1) return "其他产品";
        const inferredProducts = detectProducts(fallbackText);
        if (inferredProducts.length === 1) return inferredProducts[0];
        return "其他产品";
      }
      function normalizeGalleryStatus(raw, metadata, article) {
        if (
          metadata?.is_current === false ||
          metadata?.is_active === false ||
          metadata?.archived === true ||
          article?.is_current === false ||
          article?.is_active === false ||
          article?.archived === true
        ) {
          return "history";
        }
        const value = String(raw || "").trim().toLowerCase();
        if (/history|historical|archive|archived|旧版|历史/.test(value)) {
          return "history";
        }
        return "current";
      }
      function galleryTimestamp(raw) {
        if (raw === undefined || raw === null || raw === "") return 0;
        let value = raw;
        if (typeof value === "number" && value > 0 && value < 1e12) {
          value *= 1000;
        }
        const timestamp = new Date(value).getTime();
        return Number.isFinite(timestamp) ? timestamp : 0;
      }
      function formatGalleryDate(raw) {
        const timestamp = galleryTimestamp(raw);
        if (!timestamp) return "暂无记录";
        return new Intl.DateTimeFormat("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(timestamp);
      }
      function getPriceGalleryAssets(gi) {
        const group = groups[gi];
        if (!group) return [];
        const assets = [];
        (group.items || []).forEach((article, ii) => {
          const contentId = article.content_id || id(gi, ii);
          const images = getArticleImages(article, gi, ii);
          const records = images.length ? images : [null];
          records.forEach((image, imageIndex) => {
            const metadata = image
              ? getGalleryRawImage(article, contentId, image)
              : {};
            const fallbackText = [
              article.title,
              image?.file_name,
              image?.alt,
              image?.caption,
              ...(Array.isArray(article.paragraphs)
                ? article.paragraphs.slice(0, 1)
                : []),
            ].join(" ");
            const productRaw = firstGalleryValue(
              metadata.product,
              metadata.product_name,
              metadata.product_category,
              metadata.productCategory,
              metadata.product_type,
              metadata.productType,
              metadata.category,
              metadata.category_name,
              article.product,
              article.product_name,
              article.product_category,
              article.productCategory,
              article.product_type,
              article.productType,
              article.category,
              article.category_name,
            );
            const statusRaw = firstGalleryValue(
              metadata.status,
              metadata.version_status,
              metadata.versionStatus,
              metadata.state,
              article.status,
              article.version_status,
              article.versionStatus,
              article.state,
            );
            const uploadedAt = firstGalleryValue(
              metadata.uploaded_at,
              metadata.uploadedAt,
              metadata.upload_time,
              metadata.created_at,
              metadata.createdAt,
              article.uploaded_at,
              article.uploadedAt,
              article.upload_time,
              article.created_at,
              article.createdAt,
            );
            const updatedAt = firstGalleryValue(
              metadata.updated_at,
              metadata.updatedAt,
              metadata.update_time,
              metadata.last_updated,
              article.updated_at,
              article.updatedAt,
              article.update_time,
              article.last_updated,
            );
            const name = firstGalleryValue(
              metadata.name,
              metadata.image_name,
              metadata.title,
              metadata.file_name,
              article.title,
              image?.file_name,
              image?.alt,
              `价格图 ${assets.length + 1}`,
            );
            const note = firstGalleryValue(
              metadata.note,
              metadata.remark,
              metadata.memo,
              metadata.description,
              image?.caption,
              article.note,
              article.remark,
              article.memo,
              article.description,
              Array.isArray(article.paragraphs)
                ? article.paragraphs[0]
                : "",
            );
            const sortOrderRaw =
              metadata.sort_order ??
              metadata.sortOrder ??
              article.sort_order ??
              article.sortOrder;
            const sortOrder = Number(sortOrderRaw);
            const hasSortOrder =
              sortOrderRaw !== undefined &&
              sortOrderRaw !== null &&
              String(sortOrderRaw).trim() &&
              Number.isFinite(sortOrder);
            assets.push({
              gi,
              ii,
              imageIndex,
              image,
              contentId,
              name,
              product: normalizeGalleryProduct(productRaw, fallbackText),
              status: normalizeGalleryStatus(statusRaw, metadata, article),
              note: note || "暂无备注",
              uploadedAt,
              updatedAt,
              sortOrder: hasSortOrder ? sortOrder : assets.length,
              sourceIndex: assets.length,
            });
          });
        });
        return assets;
      }
      function getFilteredPriceGalleryAssets(gi) {
        const query = galleryViewState.query.trim().toLowerCase();
        const filtered = getPriceGalleryAssets(gi).filter((asset) => {
          const matchesQuery =
            !query ||
            `${asset.name} ${asset.note} ${asset.product}`
              .toLowerCase()
              .includes(query);
          const matchesProduct =
            galleryViewState.product === "all" ||
            asset.product === galleryViewState.product;
          const matchesStatus =
            galleryViewState.status === "all" ||
            asset.status === galleryViewState.status;
          return matchesQuery && matchesProduct && matchesStatus;
        });
        return filtered.sort((a, b) => {
          if (galleryViewState.sort === "updated") {
            return (
              galleryTimestamp(b.updatedAt) -
                galleryTimestamp(a.updatedAt) ||
              a.sourceIndex - b.sourceIndex
            );
          }
          if (galleryViewState.sort === "uploaded") {
            return (
              galleryTimestamp(b.uploadedAt) -
                galleryTimestamp(a.uploadedAt) ||
              a.sourceIndex - b.sourceIndex
            );
          }
          if (galleryViewState.sort === "name") {
            return (
              a.name.localeCompare(b.name, "zh-CN") ||
              a.sourceIndex - b.sourceIndex
            );
          }
          return a.sortOrder - b.sortOrder || a.sourceIndex - b.sourceIndex;
        });
      }
      function gallerySelectOptions(options, selected) {
        return options
          .map(
            ([value, label]) =>
              `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`,
          )
          .join("");
      }
      function closeGalleryMenus(except = null) {
        document.querySelectorAll(".gallery-more[open]").forEach((details) => {
          if (details !== except) details.open = false;
        });
        document.querySelectorAll(".gallery-card.menu-open").forEach((card) => {
          if (!except || card !== except.closest(".gallery-card")) {
            card.classList.remove("menu-open");
          }
        });
      }
      function positionGalleryMenu(details) {
        if (!details?.open) return;
        const summary = details.querySelector("summary");
        const menu = details.querySelector(".gallery-more-menu");
        const card = details.closest(".gallery-card");
        if (!summary || !menu || !card) return;
        const summaryRect = summary.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight;
        const width = Math.max(
          120,
          Math.min(220, cardRect.width - 16, viewportWidth - 16),
        );
        const preferredLeft = summaryRect.right - width;
        const withinCardLeft = Math.min(
          Math.max(preferredLeft, cardRect.left + 8),
          cardRect.right - width - 8,
        );
        const left = Math.min(
          Math.max(withinCardLeft, 8),
          viewportWidth - width - 8,
        );
        menu.style.width = `${width}px`;
        menu.style.left = `${left}px`;
        const menuHeight = menu.offsetHeight;
        const belowTop = summaryRect.bottom + 6;
        const top =
          belowTop + menuHeight <= viewportHeight - 8
            ? belowTop
            : Math.max(8, summaryRect.top - menuHeight - 6);
        menu.style.top = `${top}px`;
      }
      function handleGalleryMenuToggle(details) {
        if (!details.open) {
          details.closest(".gallery-card")?.classList.remove("menu-open");
          return;
        }
        closeGalleryMenus(details);
        details.closest(".gallery-card")?.classList.add("menu-open");
        requestAnimationFrame(() => positionGalleryMenu(details));
      }
      function showGalleryUploadNotice() {
        closeGalleryMenus();
        toast("价格图上传将在下一阶段开放");
      }
      function renderPriceGalleryCard(asset) {
        const statusLabel =
          asset.status === "history" ? "历史版本" : "当前使用";
        const imageHtml = asset.image
          ? `<button type="button" class="gallery-thumb-button" onclick="openImage(${asset.gi},${asset.ii},${asset.imageIndex})" aria-label="放大查看：${esc(asset.name)}"><img src="${esc(asset.image.src)}" alt="${esc(asset.image.alt || asset.name)}" loading="lazy" onerror="this.parentElement.hidden=true;this.closest('.gallery-thumb').querySelector('.gallery-thumb-fallback').hidden=false"></button><div class="gallery-thumb-fallback" hidden>图片暂时无法显示，原记录仍保留</div>`
          : '<div class="gallery-thumb-fallback">暂无图片，原记录仍保留</div>';
        return `<article class="gallery-card"><div class="gallery-thumb">${imageHtml}</div><div class="gallery-card-body"><div class="gallery-card-tags"><span class="gallery-status ${asset.status}">${statusLabel}</span><span class="gallery-product">${esc(asset.product)}</span></div><h2>${esc(asset.name)}</h2><p class="gallery-note">${esc(asset.note)}</p><dl class="gallery-dates"><div><dt>上传时间</dt><dd>${esc(formatGalleryDate(asset.uploadedAt))}</dd></div><div><dt>最后更新</dt><dd>${esc(formatGalleryDate(asset.updatedAt))}</dd></div></dl><div class="gallery-card-actions" aria-label="${esc(asset.name)}的操作"><button type="button" class="btn" disabled title="后续阶段开放">复制</button><button type="button" class="btn" disabled title="后续阶段开放">下载</button><button type="button" class="btn" disabled title="后续阶段开放">编辑</button><details class="gallery-more" ontoggle="handleGalleryMenuToggle(this)"><summary>更多</summary><div class="gallery-more-menu"><button type="button" disabled>替换图片 · 后续阶段开放</button><button type="button" disabled>移入历史版本 · 后续阶段开放</button><button type="button" disabled>删除 · 后续阶段开放</button></div></details></div></div></article>`;
      }
      function renderPriceGalleryResults() {
        if (mode !== "gallery") return;
        closeGalleryMenus();
        const assets = getFilteredPriceGalleryAssets(activeG);
        const summary = $("#gallerySummary");
        const results = $("#galleryResults");
        if (!summary || !results) return;
        summary.textContent = `共 ${assets.length} 张素材`;
        results.innerHTML = assets.length
          ? `<div class="gallery-grid">${assets
              .map(renderPriceGalleryCard)
              .join("")}</div>`
          : '<div class="gallery-empty"><b>没有符合条件的价格图</b><span>可调整搜索词或筛选条件；现有数据没有被修改。</span></div>';
      }
      function updatePriceGalleryFilter(key, value) {
        if (!["query", "product", "status", "sort"].includes(key)) return;
        closeGalleryMenus();
        galleryViewState[key] = String(value || "");
        renderPriceGalleryResults();
      }
      function renderPriceGallery() {
        const productOptions = [
          ["all", "全部"],
          ...GALLERY_PRODUCTS.map((product) => [product, product]),
        ];
        closeGalleryMenus();
        $("#main").innerHTML = `<section class="gallery-shell" aria-labelledby="galleryTitle"><header class="gallery-header"><div><p class="gallery-eyebrow">产品价格图</p><h1 id="galleryTitle">价格图素材库</h1><p>集中查看并筛选现有价格图。第一阶段仅提供兼容展示，不改写旧数据。</p></div><button type="button" class="btn primary gallery-upload" onclick="showGalleryUploadNotice()">上传价格图</button></header><div class="gallery-toolbar" role="search" aria-label="价格图筛选"><label class="gallery-search-field"><span>搜索</span><input id="gallerySearch" type="search" value="${esc(galleryViewState.query)}" placeholder="搜索图片名称、备注或产品" oninput="updatePriceGalleryFilter('query',this.value)"></label><label><span>产品分类</span><select onchange="updatePriceGalleryFilter('product',this.value)">${gallerySelectOptions(productOptions, galleryViewState.product)}</select></label><label><span>状态</span><select onchange="updatePriceGalleryFilter('status',this.value)">${gallerySelectOptions([["all", "全部"], ["current", "当前使用"], ["history", "历史版本"]], galleryViewState.status)}</select></label><label><span>排序方式</span><select onchange="updatePriceGalleryFilter('sort',this.value)">${gallerySelectOptions([["custom", "自定义排序"], ["updated", "最近更新"], ["uploaded", "最近上传"], ["name", "名称排序"]], galleryViewState.sort)}</select></label></div><div class="gallery-subbar"><p>微信粘贴与上传将在后续阶段开放；普通文章现有的粘贴图片功能保持不变。</p><strong id="gallerySummary"></strong></div><div id="galleryResults" aria-live="polite"></div></section>`;
        renderPriceGalleryResults();
      }
      function openPriceGallery(gi) {
        if (!isProductCenterGroup(groups[gi])) return;
        activeG = gi;
        activeI = 0;
        setMode("gallery");
        renderNav();
        renderGroupList(gi);
        renderPriceGallery();
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
        const duplicateContentId = allDocs().some(
          ({ x }) =>
            x !== article &&
            x.content_id &&
            x.content_id === article.content_id,
        );
        if (isStableContentId(article.content_id) && !duplicateContentId) {
          return article.content_id;
        }
        const oldId = article.content_id || id(g, i);
        const contentId = createContentId();
        article.content_id = contentId;
        if (!duplicateContentId) {
          favs = favs.map((value) => (value === oldId ? contentId : value));
          recent = recent.map((value) => (value === oldId ? contentId : value));
        }
        if (
          !duplicateContentId &&
          Object.prototype.hasOwnProperty.call(articleImageState, oldId)
        ) {
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
        if (m !== "gallery") closeGalleryMenus();
        mode = m;
        document
          .querySelector(".app")
          ?.classList.toggle("gallery-mode", m === "gallery");
        document
          .querySelectorAll(".navbtn[data-mode]")
          .forEach((x) => x.classList.toggle("on", x.dataset.mode === m));
      }
      function renderNav() {
        let total = 0;
        $("#cats").innerHTML = groups
          .map((g, gi) => {
            total += g.items.length;
            return `<button class="navbtn ${(mode === "group" || mode === "gallery") && gi === activeG ? "on" : ""}" onclick="openGroup(${gi})">📁 ${esc(g.title)} <em>${g.items.length}</em></button>`;
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
        renderGroupList(gi);
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
        renderGroupList(gi);
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
          `<div class="topbar"><div class="crumb">${esc(groups[activeG].title)} / ${editing ? "编辑内容" : "查看内容"}</div><div class="tools"><button class="btn" onclick="toggleFav(${activeG},${activeI})">${favs.includes(getContentId(activeG, activeI)) ? "★ 已收藏" : "☆ 收藏"}</button><button class="btn" onclick="copyCurrent()">复制</button><button class="btn primary" onclick="toggleEdit()">${editing ? "完成编辑" : "编辑"}</button><button class="btn danger" onclick="deleteCurrent()">删除</button></div></div><div class="paper">${editing ? `<div class="article-editor"><input class="titleinput" id="titleEdit" value="${esc(x.title)}"><textarea class="contentarea" id="bodyEdit">${esc(text)}</textarea>${renderImageManager(activeG, activeI)}</div>` : `<h1 style="margin:0;border-bottom:1px solid var(--line);padding-bottom:12px">${esc(x.title)}</h1>${images}${body}`}</div>`;
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
        renderGroupList(activeG);
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
        else if (mode === "gallery") {
          renderGroupList(activeG);
          renderPriceGallery();
        }
        else openGroup(activeG);
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeImageViewer();
          closeGalleryMenus();
        }
      });
      document.addEventListener("click", (event) => {
        if (!event.target.closest(".gallery-more")) closeGalleryMenus();
      });
      window.addEventListener("resize", () => closeGalleryMenus());
      $(".main")?.addEventListener("scroll", () => {
        const openMenu = document.querySelector(".gallery-more[open]");
        if (openMenu) {
          requestAnimationFrame(() => positionGalleryMenu(openMenu));
        }
      });
      renderNav();
      showHome();
