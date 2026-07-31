const KEY = "zy_kb_system_v2",
        FKEY = "zy_kb_favs_v2",
        RKEY = "zy_kb_recent_v2",
        IKEY = "zy_kb_article_images_v2",
        CATEGORY_ORDER_KEY = "zy_kb_category_order_v1",
        ARTICLE_CATEGORY_OVERRIDE_KEY = "zy_kb_article_category_overrides_v1",
        PRICE_GALLERY_META_KEY = "zy_kb_price_gallery_meta_v1",
        PRICE_GALLERY_DB_NAME = "zy_kb_price_gallery_db",
        PRICE_GALLERY_DB_VERSION = 1,
        PRICE_GALLERY_IMAGE_STORE = "images",
        PRICE_GALLERY_THUMBNAIL_STORE = "thumbnails",
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
      let categoryOrder = loadCategoryOrder();
      let articleCategoryOverrides = loadArticleCategoryOverrides();
      applyArticleCategoryOverrides();
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
      const PRICE_GALLERY_LIMITS = Object.freeze({
        maxOriginalBytes: 20 * 1024 * 1024,
        maxProcessedBytes: 2 * 1024 * 1024,
        maxFullSide: 2560,
        maxThumbnailSide: 640,
        maxThumbnailBytes: 360 * 1024,
      });
      const PRICE_GALLERY_TYPES = new Set([
        "image/jpeg",
        "image/png",
        "image/webp",
      ]);
      let priceGalleryMeta = loadPriceGalleryMeta();
      let priceGalleryDbPromise = null;
      let galleryUploadState = null;
      let galleryUploadBusy = false;
      let galleryViewerUrl = "";
      let galleryViewerRequestToken = 0;
      let galleryThumbnailRenderToken = 0;
      const galleryThumbnailUrls = new Map();
      const galleryViewState = {
        query: "",
        product: "all",
        status: "all",
        sort: "custom",
      };
      let categoryDragState = null;
      let categoryScrollObserver = null;
      let moveDialogReturnFocus = null;
      let latestMoveUndo = null;
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
        galleryViewerRequestToken += 1;
        document.querySelector(".image-viewer")?.remove();
        if (galleryViewerUrl) {
          URL.revokeObjectURL(galleryViewerUrl);
          galleryViewerUrl = "";
        }
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
      function createGalleryError(code, cause = null) {
        const error = new Error(code);
        error.galleryCode = code;
        error.cause = cause;
        return error;
      }
      function galleryErrorCode(error, fallback = "PROCESS_FAILED") {
        if (error?.galleryCode) return error.galleryCode;
        if (
          error?.name === "QuotaExceededError" ||
          error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
        ) {
          return "STORAGE_FULL";
        }
        return fallback;
      }
      function galleryErrorMessage(error) {
        const messages = {
          UNSUPPORTED_FORMAT:
            "不支持的图片格式。仅支持 JPEG/JPG、PNG 和 WebP。GIF、HEIC、SVG、PDF 暂不支持。",
          FILE_TOO_LARGE: "原文件超过 20MB，请选择更小的图片。",
          FILE_READ_FAILED: "文件读取失败，请重新选择图片。",
          DECODE_FAILED: "图片解码失败，文件可能已损坏或格式不完整。",
          PROCESS_FAILED: "图片处理失败，请更换图片后重试。",
          PROCESSED_TOO_LARGE:
            "处理后单图仍然超过 2MB，请先缩小原图尺寸后重试。",
          IDB_UNAVAILABLE:
            "IndexedDB 不可用，请检查浏览器隐私设置或更换浏览器。",
          STORAGE_FULL:
            "浏览器存储空间不足，请释放本机浏览器空间后重试。",
          META_SAVE_FAILED:
            "价格图元数据保存失败，本次图片未保留，请重试。",
          NO_CLIPBOARD_IMAGE: "剪贴板中未检测到图片。",
          CLIPBOARD_UNSUPPORTED:
            "当前浏览器不支持复制图片，请使用下载功能。",
          IMAGE_NOT_FOUND: "图片数据暂时无法读取，元数据仍然保留。",
        };
        return messages[galleryErrorCode(error)] || messages.PROCESS_FAILED;
      }
      function showGalleryError(error) {
        alert(galleryErrorMessage(error));
      }
      function sanitizeGalleryMeta(raw, index) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const assetId = String(raw.assetId || "").trim();
        if (!assetId) return null;
        const productCategory = GALLERY_PRODUCTS.includes(raw.productCategory)
          ? raw.productCategory
          : "其他产品";
        const number = (value, fallback = 0) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
        };
        return {
          assetId,
          name: String(raw.name || "未命名价格图").trim() || "未命名价格图",
          productCategory,
          note: String(raw.note || ""),
          status: raw.status === "history" ? "history" : "current",
          customOrder: number(raw.customOrder, index),
          createdAt: String(raw.createdAt || ""),
          updatedAt: String(raw.updatedAt || ""),
          originalName: String(raw.originalName || ""),
          originalType: String(raw.originalType || ""),
          originalSize: number(raw.originalSize),
          processedSize: number(raw.processedSize),
          width: number(raw.width),
          height: number(raw.height),
        };
      }
      function loadPriceGalleryMeta() {
        try {
          const parsed = JSON.parse(
            localStorage.getItem(PRICE_GALLERY_META_KEY) || "[]",
          );
          if (!Array.isArray(parsed)) return [];
          const seen = new Set();
          return parsed
            .map(sanitizeGalleryMeta)
            .filter((asset) => {
              if (!asset || seen.has(asset.assetId)) return false;
              seen.add(asset.assetId);
              return true;
            });
        } catch (error) {
          return [];
        }
      }
      function persistPriceGalleryMeta(nextMeta) {
        const normalized = nextMeta
          .map(sanitizeGalleryMeta)
          .filter(Boolean);
        try {
          localStorage.setItem(
            PRICE_GALLERY_META_KEY,
            JSON.stringify(normalized),
          );
          priceGalleryMeta = normalized;
          return true;
        } catch (error) {
          throw createGalleryError(
            galleryErrorCode(error, "META_SAVE_FAILED") === "STORAGE_FULL"
              ? "STORAGE_FULL"
              : "META_SAVE_FAILED",
            error,
          );
        }
      }
      function openPriceGalleryDb() {
        if (!globalThis.indexedDB) {
          return Promise.reject(createGalleryError("IDB_UNAVAILABLE"));
        }
        if (priceGalleryDbPromise) return priceGalleryDbPromise;
        priceGalleryDbPromise = new Promise((resolve, reject) => {
          let request;
          try {
            request = indexedDB.open(
              PRICE_GALLERY_DB_NAME,
              PRICE_GALLERY_DB_VERSION,
            );
          } catch (error) {
            reject(createGalleryError("IDB_UNAVAILABLE", error));
            return;
          }
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PRICE_GALLERY_IMAGE_STORE)) {
              db.createObjectStore(PRICE_GALLERY_IMAGE_STORE, {
                keyPath: "assetId",
              });
            }
            if (
              !db.objectStoreNames.contains(
                PRICE_GALLERY_THUMBNAIL_STORE,
              )
            ) {
              db.createObjectStore(PRICE_GALLERY_THUMBNAIL_STORE, {
                keyPath: "assetId",
              });
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => {
              db.close();
              priceGalleryDbPromise = null;
            };
            resolve(db);
          };
          request.onerror = () =>
            reject(createGalleryError("IDB_UNAVAILABLE", request.error));
          request.onblocked = () =>
            reject(createGalleryError("IDB_UNAVAILABLE"));
        }).catch((error) => {
          priceGalleryDbPromise = null;
          throw error;
        });
        return priceGalleryDbPromise;
      }
      function waitForGalleryTransaction(transaction) {
        return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () =>
            reject(
              createGalleryError(
                galleryErrorCode(transaction.error, "IDB_UNAVAILABLE"),
                transaction.error,
              ),
            );
          transaction.onabort = () =>
            reject(
              createGalleryError(
                galleryErrorCode(transaction.error, "IDB_UNAVAILABLE"),
                transaction.error,
              ),
            );
        });
      }
      function galleryRequest(request) {
        return new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(
              createGalleryError(
                galleryErrorCode(request.error, "IDB_UNAVAILABLE"),
                request.error,
              ),
            );
        });
      }
      async function putPriceGalleryBlobs(assetId, full, thumbnail) {
        const db = await openPriceGalleryDb();
        let transaction;
        try {
          transaction = db.transaction(
            [PRICE_GALLERY_IMAGE_STORE, PRICE_GALLERY_THUMBNAIL_STORE],
            "readwrite",
          );
          transaction.objectStore(PRICE_GALLERY_IMAGE_STORE).put({
            assetId,
            blob: full.blob,
            width: full.width,
            height: full.height,
            size: full.blob.size,
            mimeType: "image/webp",
          });
          transaction.objectStore(PRICE_GALLERY_THUMBNAIL_STORE).put({
            assetId,
            blob: thumbnail.blob,
            width: thumbnail.width,
            height: thumbnail.height,
            size: thumbnail.blob.size,
            mimeType: "image/webp",
          });
          await waitForGalleryTransaction(transaction);
        } catch (error) {
          throw createGalleryError(
            galleryErrorCode(error, "IDB_UNAVAILABLE"),
            error,
          );
        }
      }
      async function getPriceGalleryBlobRecord(storeName, assetId) {
        const db = await openPriceGalleryDb();
        let transaction;
        try {
          transaction = db.transaction(storeName, "readonly");
          return await galleryRequest(
            transaction.objectStore(storeName).get(assetId),
          );
        } catch (error) {
          throw createGalleryError(
            galleryErrorCode(error, "IDB_UNAVAILABLE"),
            error,
          );
        }
      }
      async function deletePriceGalleryBlobs(assetId) {
        const db = await openPriceGalleryDb();
        const transaction = db.transaction(
          [PRICE_GALLERY_IMAGE_STORE, PRICE_GALLERY_THUMBNAIL_STORE],
          "readwrite",
        );
        transaction.objectStore(PRICE_GALLERY_IMAGE_STORE).delete(assetId);
        transaction
          .objectStore(PRICE_GALLERY_THUMBNAIL_STORE)
          .delete(assetId);
        await waitForGalleryTransaction(transaction);
      }
      async function verifyPriceGalleryBlobs(assetId) {
        const [full, thumbnail] = await Promise.all([
          getPriceGalleryBlobRecord(PRICE_GALLERY_IMAGE_STORE, assetId),
          getPriceGalleryBlobRecord(PRICE_GALLERY_THUMBNAIL_STORE, assetId),
        ]);
        if (!(full?.blob instanceof Blob) || !(thumbnail?.blob instanceof Blob)) {
          throw createGalleryError("IDB_UNAVAILABLE");
        }
      }
      function createPriceGalleryAssetId() {
        const used = new Set(priceGalleryMeta.map((asset) => asset.assetId));
        let assetId = "";
        do {
          const random =
            globalThis.crypto?.randomUUID?.().replace(/-/g, "") ||
            Math.random().toString(36).slice(2) + Date.now().toString(36);
          assetId = `price_asset_${random}`;
        } while (used.has(assetId));
        return assetId;
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
      function getPriceGalleryAssets() {
        return priceGalleryMeta.map((asset, sourceIndex) => ({
          ...asset,
          product: asset.productCategory,
          uploadedAt: asset.createdAt,
          sortOrder: asset.customOrder,
          sourceIndex,
        }));
      }
      function getFilteredPriceGalleryAssets() {
        const query = galleryViewState.query.trim().toLowerCase();
        const filtered = getPriceGalleryAssets().filter((asset) => {
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
      function canvasToGalleryBlob(canvas, type, quality) {
        return new Promise((resolve, reject) => {
          try {
            canvas.toBlob(
              (blob) => {
                if (!blob || blob.type !== type) {
                  reject(createGalleryError("PROCESS_FAILED"));
                  return;
                }
                resolve(blob);
              },
              type,
              quality,
            );
          } catch (error) {
            reject(createGalleryError("PROCESS_FAILED", error));
          }
        });
      }
      function decodeGalleryImage(blob) {
        if (typeof createImageBitmap === "function") {
          return createImageBitmap(blob, { imageOrientation: "from-image" })
            .then((image) => ({
              image,
              width: image.width,
              height: image.height,
              close: () => image.close?.(),
            }))
            .catch(() => decodeGalleryImageElement(blob));
        }
        return decodeGalleryImageElement(blob);
      }
      function decodeGalleryImageElement(blob) {
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(blob);
          const image = new Image();
          image.onload = () => {
            resolve({
              image,
              width: image.naturalWidth,
              height: image.naturalHeight,
              close: () => URL.revokeObjectURL(url),
            });
          };
          image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(createGalleryError("DECODE_FAILED"));
          };
          image.src = url;
        });
      }
      async function encodeGalleryWebp(
        decoded,
        maxSide,
        targetBytes,
        qualities,
        maxStages,
        shrink,
      ) {
        const initialScale = Math.min(
          1,
          maxSide / Math.max(decoded.width, decoded.height),
        );
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw createGalleryError("PROCESS_FAILED");
        let smallest = null;
        for (let stage = 0; stage < maxStages; stage += 1) {
          const scale = initialScale * Math.pow(shrink, stage);
          const width = Math.max(1, Math.round(decoded.width * scale));
          const height = Math.max(1, Math.round(decoded.height * scale));
          canvas.width = width;
          canvas.height = height;
          context.clearRect(0, 0, width, height);
          context.drawImage(decoded.image, 0, 0, width, height);
          for (const quality of qualities) {
            const blob = await canvasToGalleryBlob(
              canvas,
              "image/webp",
              quality,
            );
            if (!smallest || blob.size < smallest.blob.size) {
              smallest = { blob, width, height };
            }
            if (blob.size <= targetBytes) return { blob, width, height };
          }
        }
        if (smallest?.blob.size <= targetBytes) return smallest;
        throw createGalleryError("PROCESSED_TOO_LARGE");
      }
      async function processPriceGalleryFile(file) {
        if (!file || !PRICE_GALLERY_TYPES.has(String(file.type).toLowerCase())) {
          throw createGalleryError("UNSUPPORTED_FORMAT");
        }
        if (file.size > PRICE_GALLERY_LIMITS.maxOriginalBytes) {
          throw createGalleryError("FILE_TOO_LARGE");
        }
        let sourceBlob;
        try {
          const bytes = await file.arrayBuffer();
          sourceBlob = new Blob([bytes], { type: file.type.toLowerCase() });
        } catch (error) {
          throw createGalleryError("FILE_READ_FAILED", error);
        }
        let decoded;
        try {
          decoded = await decodeGalleryImage(sourceBlob);
        } catch (error) {
          throw createGalleryError("DECODE_FAILED", error);
        }
        if (!decoded.width || !decoded.height) {
          decoded.close?.();
          throw createGalleryError("DECODE_FAILED");
        }
        try {
          const full = await encodeGalleryWebp(
            decoded,
            PRICE_GALLERY_LIMITS.maxFullSide,
            PRICE_GALLERY_LIMITS.maxProcessedBytes,
            [0.94, 0.91, 0.88, 0.85, 0.82],
            5,
            0.9,
          );
          const thumbnail = await encodeGalleryWebp(
            decoded,
            PRICE_GALLERY_LIMITS.maxThumbnailSide,
            PRICE_GALLERY_LIMITS.maxThumbnailBytes,
            [0.86, 0.8, 0.74],
            4,
            0.88,
          );
          return { full, thumbnail };
        } catch (error) {
          if (galleryErrorCode(error) === "PROCESSED_TOO_LARGE") throw error;
          throw createGalleryError("PROCESS_FAILED", error);
        } finally {
          decoded.close?.();
        }
      }
      function setGalleryUploadBusy(busy) {
        galleryUploadBusy = busy;
        const uploadButton = document.querySelector(".gallery-upload");
        if (uploadButton) {
          uploadButton.disabled = busy;
          uploadButton.textContent = busy ? "正在处理图片…" : "上传价格图";
        }
        const confirmButton = $("#savePriceGalleryAsset");
        const cancelButton = $("#cancelPriceGalleryUpload");
        if (confirmButton) confirmButton.disabled = busy || !isGalleryUploadValid();
        if (cancelButton) cancelButton.disabled = busy;
      }
      function isGalleryUploadValid() {
        return Boolean(
          galleryUploadState &&
            $("#galleryAssetName")?.value.trim() &&
            GALLERY_PRODUCTS.includes($("#galleryAssetProduct")?.value),
        );
      }
      function ensureGalleryUploadDialog() {
        let backdrop = $("#priceGalleryUploadDialog");
        if (backdrop) return backdrop;
        backdrop = document.createElement("div");
        backdrop.id = "priceGalleryUploadDialog";
        backdrop.className = "gallery-upload-backdrop";
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        backdrop.innerHTML = `<section class="gallery-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="galleryUploadTitle"><header><div><p>价格图素材</p><h2 id="galleryUploadTitle">上传价格图</h2></div><button type="button" class="gallery-upload-close" aria-label="关闭上传价格图窗口" title="关闭" onclick="closeGalleryUploadDialog()">×</button></header><div class="gallery-upload-content"><div class="gallery-upload-preview"><img id="galleryUploadPreview" alt="待上传价格图预览"><span id="galleryUploadDimensions"></span></div><div class="gallery-upload-fields"><label><span>图片名称</span><input id="galleryAssetName" type="text" maxlength="120" oninput="updateGalleryUploadConfirm()"></label><label><span>产品分类</span><select id="galleryAssetProduct" onchange="updateGalleryUploadConfirm()"><option value="">请选择产品分类</option>${GALLERY_PRODUCTS.map((product) => `<option value="${esc(product)}">${esc(product)}</option>`).join("")}</select></label><label><span>备注</span><textarea id="galleryAssetNote" rows="4" maxlength="500" placeholder="可填写价格、版本或使用场景等简短备注"></textarea></label><label><span>状态</span><select disabled><option>当前使用</option></select></label></div></div><footer><button type="button" class="btn" id="cancelPriceGalleryUpload" onclick="closeGalleryUploadDialog()">取消</button><button type="button" class="btn primary" id="savePriceGalleryAsset" onclick="savePriceGalleryAsset()" disabled>确认保存</button></footer></section>`;
        backdrop.addEventListener("click", (event) => {
          if (event.target === backdrop) closeGalleryUploadDialog();
        });
        document.body.appendChild(backdrop);
        return backdrop;
      }
      function updateGalleryUploadConfirm() {
        const button = $("#savePriceGalleryAsset");
        if (button) button.disabled = galleryUploadBusy || !isGalleryUploadValid();
      }
      function openGalleryUploadDialog(file, processed, source) {
        closeGalleryUploadDialog(true);
        const backdrop = ensureGalleryUploadDialog();
        const previewUrl = URL.createObjectURL(processed.thumbnail.blob);
        galleryUploadState = {
          assetId: createPriceGalleryAssetId(),
          file,
          full: processed.full,
          thumbnail: processed.thumbnail,
          previewUrl,
          source,
          returnFocus: document.activeElement,
        };
        const fallbackName =
          source === "clipboard"
            ? "微信价格图"
            : String(file.name || "价格图").replace(/\.[^.]+$/, "");
        $("#galleryUploadPreview").src = previewUrl;
        $("#galleryUploadPreview").alt = `${fallbackName}预览`;
        $("#galleryUploadDimensions").textContent =
          `${processed.full.width} × ${processed.full.height} · WebP ${formatFileSize(processed.full.blob.size)}`;
        $("#galleryAssetName").value = fallbackName || "价格图";
        $("#galleryAssetProduct").value = "";
        $("#galleryAssetNote").value = "";
        backdrop.hidden = false;
        backdrop.setAttribute("aria-hidden", "false");
        document.body.classList.add("uploading-gallery-image");
        updateGalleryUploadConfirm();
        requestAnimationFrame(() => $("#galleryAssetName")?.focus());
      }
      function closeGalleryUploadDialog(force = false) {
        if (galleryUploadBusy && !force) return;
        const backdrop = $("#priceGalleryUploadDialog");
        if (!backdrop || backdrop.hidden) return;
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        document.body.classList.remove("uploading-gallery-image");
        const state = galleryUploadState;
        galleryUploadState = null;
        if (state?.previewUrl) URL.revokeObjectURL(state.previewUrl);
        if (!force) state?.returnFocus?.focus?.();
      }
      function formatFileSize(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
        return `${(value / (1024 * 1024)).toFixed(2)} MB`;
      }
      async function startPriceGalleryUpload(file, source = "file") {
        if (galleryUploadBusy || !file) return;
        closeGalleryMenus();
        setGalleryUploadBusy(true);
        try {
          const processed = await processPriceGalleryFile(file);
          if (mode !== "gallery") return;
          openGalleryUploadDialog(file, processed, source);
        } catch (error) {
          showGalleryError(error);
        } finally {
          setGalleryUploadBusy(false);
        }
      }
      function selectPriceGalleryFile() {
        if (galleryUploadBusy) return;
        $("#priceGalleryFileInput")?.click();
      }
      function handlePriceGalleryFileInput(event) {
        const input = event.currentTarget;
        const file = input.files?.[0];
        input.value = "";
        if (file) startPriceGalleryUpload(file, "file");
      }
      async function savePriceGalleryAsset() {
        const state = galleryUploadState;
        if (!state || galleryUploadBusy || !isGalleryUploadValid()) return;
        const name = $("#galleryAssetName").value.trim();
        const productCategory = $("#galleryAssetProduct").value;
        const note = $("#galleryAssetNote").value.trim();
        const now = new Date().toISOString();
        const nextOrder = priceGalleryMeta.reduce(
          (highest, asset) => Math.max(highest, asset.customOrder),
          -1,
        ) + 1;
        const metadata = {
          assetId: state.assetId,
          name,
          productCategory,
          note,
          status: "current",
          customOrder: nextOrder,
          createdAt: now,
          updatedAt: now,
          originalName:
            state.source === "clipboard"
              ? state.file.name || "微信剪贴板图片"
              : state.file.name || "价格图",
          originalType: state.file.type,
          originalSize: state.file.size,
          processedSize: state.full.blob.size,
          width: state.full.width,
          height: state.full.height,
        };
        setGalleryUploadBusy(true);
        let wroteBlobs = false;
        try {
          await putPriceGalleryBlobs(
            state.assetId,
            state.full,
            state.thumbnail,
          );
          wroteBlobs = true;
          await verifyPriceGalleryBlobs(state.assetId);
          try {
            persistPriceGalleryMeta([...priceGalleryMeta, metadata]);
          } catch (error) {
            try {
              await deletePriceGalleryBlobs(state.assetId);
              wroteBlobs = false;
            } catch (rollbackError) {
              // 外层会再次尝试回滚，避免元数据失败后留下孤立 Blob。
            }
            throw error;
          }
          setGalleryUploadBusy(false);
          closeGalleryUploadDialog();
          if (mode === "gallery") renderPriceGalleryResults();
          toast("价格图已保存");
        } catch (error) {
          if (wroteBlobs) {
            await deletePriceGalleryBlobs(state.assetId).catch(() => {});
          }
          showGalleryError(error);
        } finally {
          setGalleryUploadBusy(false);
        }
      }
      function handlePriceGalleryPaste(event) {
        if (
          mode !== "gallery" ||
          galleryUploadBusy ||
          galleryUploadState
        ) {
          return;
        }
        const items = [...(event.clipboardData?.items || [])];
        const itemFiles = items
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
        if (!files.length) {
          if (
            event.target.closest?.(
              'input, textarea, select, [contenteditable="true"]',
            )
          ) {
            return;
          }
          toast(galleryErrorMessage(createGalleryError("NO_CLIPBOARD_IMAGE")));
          return;
        }
        event.preventDefault();
        if (files.length > 1) {
          toast("本次只处理第 1 张图片，请逐张粘贴");
        }
        startPriceGalleryUpload(files[0], "clipboard");
      }
      function clearGalleryThumbnailUrls() {
        galleryThumbnailRenderToken += 1;
        galleryThumbnailUrls.forEach((url) => URL.revokeObjectURL(url));
        galleryThumbnailUrls.clear();
      }
      async function loadGalleryThumbnails(assets, token) {
        await Promise.all(
          assets.map(async (asset) => {
            try {
              const record = await getPriceGalleryBlobRecord(
                PRICE_GALLERY_THUMBNAIL_STORE,
                asset.assetId,
              );
              if (!(record?.blob instanceof Blob)) {
                throw createGalleryError("IMAGE_NOT_FOUND");
              }
              const url = URL.createObjectURL(record.blob);
              if (
                token !== galleryThumbnailRenderToken ||
                mode !== "gallery"
              ) {
                URL.revokeObjectURL(url);
                return;
              }
              const card = [...document.querySelectorAll(".gallery-card")].find(
                (candidate) => candidate.dataset.assetId === asset.assetId,
              );
              const image = card?.querySelector(".gallery-thumb img");
              const fallback = card?.querySelector(".gallery-thumb-fallback");
              if (!image || !fallback) {
                URL.revokeObjectURL(url);
                return;
              }
              const previous = galleryThumbnailUrls.get(asset.assetId);
              if (previous) URL.revokeObjectURL(previous);
              galleryThumbnailUrls.set(asset.assetId, url);
              image.src = url;
              image.hidden = false;
              fallback.hidden = true;
            } catch (error) {
              const card = [...document.querySelectorAll(".gallery-card")].find(
                (candidate) => candidate.dataset.assetId === asset.assetId,
              );
              const fallback = card?.querySelector(".gallery-thumb-fallback");
              if (fallback) {
                fallback.hidden = false;
                fallback.textContent =
                  "缩略图暂时无法读取，原素材仍保留";
              }
            }
          }),
        );
      }
      function handleGalleryThumbnailError(image) {
        image.hidden = true;
        const fallback = image
          .closest(".gallery-thumb")
          ?.querySelector(".gallery-thumb-fallback");
        if (fallback) {
          fallback.hidden = false;
          fallback.textContent = "缩略图暂时无法显示，原素材仍保留";
        }
      }
      async function openPriceGalleryAsset(assetId) {
        closeImageViewer();
        const requestToken = ++galleryViewerRequestToken;
        try {
          const record = await getPriceGalleryBlobRecord(
            PRICE_GALLERY_IMAGE_STORE,
            assetId,
          );
          if (!(record?.blob instanceof Blob)) {
            throw createGalleryError("IMAGE_NOT_FOUND");
          }
          if (requestToken !== galleryViewerRequestToken) return;
          const asset = priceGalleryMeta.find(
            (candidate) => candidate.assetId === assetId,
          );
          galleryViewerUrl = URL.createObjectURL(record.blob);
          const viewer = document.createElement("div");
          viewer.className = "image-viewer";
          viewer.setAttribute("role", "dialog");
          viewer.setAttribute("aria-modal", "true");
          viewer.setAttribute("aria-label", asset?.name || "价格图大图");
          viewer.innerHTML = `<button type="button" class="image-viewer-close" onclick="closeImageViewer()" aria-label="关闭图片">×</button><div class="image-viewer-content"><img src="${esc(galleryViewerUrl)}" alt="${esc(asset?.name || "价格图")}">${asset?.note ? `<div>${esc(asset.note)}</div>` : ""}</div>`;
          viewer.addEventListener("click", (event) => {
            if (event.target === viewer) closeImageViewer();
          });
          document.body.appendChild(viewer);
          document.body.classList.add("viewing-image");
          viewer.querySelector(".image-viewer-close")?.focus();
        } catch (error) {
          showGalleryError(error);
        }
      }
      async function galleryBlobToPng(blob) {
        const decoded = await decodeGalleryImage(blob);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = decoded.width;
          canvas.height = decoded.height;
          const context = canvas.getContext("2d", { alpha: true });
          if (!context) throw createGalleryError("PROCESS_FAILED");
          context.drawImage(decoded.image, 0, 0);
          return await canvasToGalleryBlob(canvas, "image/png");
        } finally {
          decoded.close?.();
        }
      }
      async function copyPriceGalleryAsset(assetId) {
        if (!navigator.clipboard?.write || typeof ClipboardItem !== "function") {
          showGalleryError(createGalleryError("CLIPBOARD_UNSUPPORTED"));
          return;
        }
        try {
          const record = await getPriceGalleryBlobRecord(
            PRICE_GALLERY_IMAGE_STORE,
            assetId,
          );
          if (!(record?.blob instanceof Blob)) {
            throw createGalleryError("IMAGE_NOT_FOUND");
          }
          const supportsWebp = ClipboardItem.supports?.("image/webp") === true;
          const blob = supportsWebp
            ? record.blob
            : await galleryBlobToPng(record.blob);
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob }),
          ]);
          toast("价格图已复制");
        } catch (error) {
          if (error?.galleryCode) showGalleryError(error);
          else toast("复制图片失败，请允许剪贴板权限或使用下载");
        }
      }
      function safeGalleryDownloadName(name) {
        const cleaned = String(name || "价格图")
          .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100);
        return `${cleaned || "价格图"}.webp`;
      }
      async function downloadPriceGalleryAsset(assetId) {
        try {
          const record = await getPriceGalleryBlobRecord(
            PRICE_GALLERY_IMAGE_STORE,
            assetId,
          );
          if (!(record?.blob instanceof Blob)) {
            throw createGalleryError("IMAGE_NOT_FOUND");
          }
          const asset = priceGalleryMeta.find(
            (candidate) => candidate.assetId === assetId,
          );
          const url = URL.createObjectURL(record.blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = safeGalleryDownloadName(asset?.name);
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          toast("价格图已下载");
        } catch (error) {
          showGalleryError(error);
        }
      }
      function renderPriceGalleryCard(asset) {
        const statusLabel =
          asset.status === "history" ? "历史版本" : "当前使用";
        const note = asset.note || "暂无备注";
        const imageHtml = `<button type="button" class="gallery-thumb-button" onclick="openPriceGalleryAsset(this.closest('.gallery-card').dataset.assetId)" aria-label="放大查看：${esc(asset.name)}"><img alt="${esc(asset.name)}" loading="lazy" hidden onerror="handleGalleryThumbnailError(this)"></button><div class="gallery-thumb-fallback">正在加载缩略图…</div>`;
        return `<article class="gallery-card" data-asset-id="${esc(asset.assetId)}"><div class="gallery-thumb">${imageHtml}</div><div class="gallery-card-body"><div class="gallery-card-tags"><span class="gallery-status ${asset.status}">${statusLabel}</span><span class="gallery-product">${esc(asset.product)}</span></div><h2>${esc(asset.name)}</h2><p class="gallery-note">${esc(note)}</p><dl class="gallery-dates"><div><dt>上传时间</dt><dd>${esc(formatGalleryDate(asset.uploadedAt))}</dd></div><div><dt>最后更新</dt><dd>${esc(formatGalleryDate(asset.updatedAt))}</dd></div></dl><div class="gallery-card-actions" aria-label="${esc(asset.name)}的操作"><button type="button" class="btn" onclick="copyPriceGalleryAsset(this.closest('.gallery-card').dataset.assetId)">复制</button><button type="button" class="btn" onclick="downloadPriceGalleryAsset(this.closest('.gallery-card').dataset.assetId)">下载</button><button type="button" class="btn" disabled title="后续阶段开放">编辑</button><details class="gallery-more" ontoggle="handleGalleryMenuToggle(this)"><summary>更多</summary><div class="gallery-more-menu"><button type="button" disabled>替换图片 · 后续阶段开放</button><button type="button" disabled>移入历史版本 · 后续阶段开放</button><button type="button" disabled>删除 · 后续阶段开放</button></div></details></div></div></article>`;
      }
      function renderPriceGalleryResults() {
        if (mode !== "gallery") return;
        closeGalleryMenus();
        clearGalleryThumbnailUrls();
        const token = galleryThumbnailRenderToken;
        const assets = getFilteredPriceGalleryAssets();
        const summary = $("#gallerySummary");
        const results = $("#galleryResults");
        if (!summary || !results) return;
        summary.textContent = `共 ${assets.length} 张素材`;
        if (assets.length) {
          results.innerHTML = `<div class="gallery-grid">${assets
            .map(renderPriceGalleryCard)
            .join("")}</div>`;
          loadGalleryThumbnails(assets, token);
          return;
        }
        results.innerHTML = priceGalleryMeta.length
          ? '<div class="gallery-empty"><b>没有符合条件的价格图</b><span>可调整搜索词或筛选条件。</span></div>'
          : '<div class="gallery-empty"><b>暂无价格图，可通过上传或粘贴添加</b><span>价格图仅保存在当前浏览器，不会自动跨设备同步。</span></div>';
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
        $("#main").innerHTML = `<section class="gallery-shell" aria-labelledby="galleryTitle"><header class="gallery-header"><div><p class="gallery-eyebrow">产品价格图</p><h1 id="galleryTitle">价格图素材库</h1><p>上传或粘贴价格图后，原图和缩略图保存在当前浏览器。本机数据不会自动跨设备同步。</p></div><div><button type="button" class="btn primary gallery-upload" onclick="selectPriceGalleryFile()">上传价格图</button><input id="priceGalleryFileInput" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" aria-label="选择价格图文件" hidden onchange="handlePriceGalleryFileInput(event)"></div></header><div class="gallery-toolbar" role="search" aria-label="价格图筛选"><label class="gallery-search-field"><span>搜索</span><input id="gallerySearch" type="search" value="${esc(galleryViewState.query)}" placeholder="搜索图片名称、备注或产品" oninput="updatePriceGalleryFilter('query',this.value)"></label><label><span>产品分类</span><select onchange="updatePriceGalleryFilter('product',this.value)">${gallerySelectOptions(productOptions, galleryViewState.product)}</select></label><label><span>状态</span><select onchange="updatePriceGalleryFilter('status',this.value)">${gallerySelectOptions([["all", "全部"], ["current", "当前使用"], ["history", "历史版本"]], galleryViewState.status)}</select></label><label><span>排序方式</span><select onchange="updatePriceGalleryFilter('sort',this.value)">${gallerySelectOptions([["custom", "自定义排序"], ["updated", "最近更新"], ["uploaded", "最近上传"], ["name", "名称排序"]], galleryViewState.sort)}</select></label></div><div class="gallery-subbar"><p>在图库空白区域按 Command+V / Ctrl+V，可粘贴从微信复制的图片；一次处理 1 张。</p><strong id="gallerySummary"></strong></div><div id="galleryResults" aria-live="polite"></div></section>`;
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
      function loadArticleCategoryOverrides() {
        try {
          const parsed = JSON.parse(
            localStorage.getItem(ARTICLE_CATEGORY_OVERRIDE_KEY) || "{}",
          );
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
          }
          const normalized = {};
          Object.entries(parsed).forEach(([key, raw]) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
            const contentId = String(raw.content_id || key || "").trim();
            const sourceCategoryId = String(
              raw.source_category_id || "",
            ).trim();
            const targetCategoryId = String(
              raw.target_category_id || "",
            ).trim();
            if (
              !isStableContentId(contentId) ||
              !sourceCategoryId ||
              !targetCategoryId ||
              sourceCategoryId === targetCategoryId
            ) {
              return;
            }
            normalized[contentId] = {
              content_id: contentId,
              source_category_id: sourceCategoryId,
              target_category_id: targetCategoryId,
              moved_at: String(raw.moved_at || ""),
            };
          });
          return normalized;
        } catch (error) {
          return {};
        }
      }
      function persistArticleCategoryOverrides() {
        try {
          localStorage.setItem(
            ARTICLE_CATEGORY_OVERRIDE_KEY,
            JSON.stringify(articleCategoryOverrides),
          );
          return true;
        } catch (error) {
          toast("移动结果保存失败");
          return false;
        }
      }
      function findGroupIndexByCategoryId(categoryId) {
        return groups.findIndex(
          (group, gi) =>
            getCategoryOrderId(group, gi) === String(categoryId || ""),
        );
      }
      function findArticleByContentId(contentId) {
        for (let gi = 0; gi < groups.length; gi += 1) {
          const ii = groups[gi].items.findIndex(
            (article) => article?.content_id === contentId,
          );
          if (ii >= 0) {
            return { gi, ii, group: groups[gi], article: groups[gi].items[ii] };
          }
        }
        return null;
      }
      function relocateArticleByContentId(contentId, targetCategoryId) {
        const targetIndex = findGroupIndexByCategoryId(targetCategoryId);
        if (targetIndex < 0) return null;
        const current = findArticleByContentId(contentId);
        if (!current) return null;
        const article = current.article;
        groups.forEach((group) => {
          group.items = group.items.filter(
            (candidate) => candidate?.content_id !== contentId,
          );
        });
        groups[targetIndex].items.unshift(article);
        return {
          article,
          sourceIndex: current.gi,
          targetIndex,
        };
      }
      function applyArticleCategoryOverrides() {
        Object.values(articleCategoryOverrides)
          .sort(
            (a, b) =>
              new Date(a.moved_at || 0).getTime() -
              new Date(b.moved_at || 0).getTime(),
          )
          .forEach((record) => {
            if (findGroupIndexByCategoryId(record.target_category_id) < 0) {
              return;
            }
            relocateArticleByContentId(
              record.content_id,
              record.target_category_id,
            );
          });
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
        const preferredCategoryByContentId = new Map();
        stored.forEach((group, gi) => {
          const categoryId = String(group?.category_id || `group_${gi}`);
          (group?.items || []).forEach((article) => {
            if (
              article?.content_id &&
              !preferredCategoryByContentId.has(article.content_id)
            ) {
              preferredCategoryByContentId.set(article.content_id, categoryId);
            }
          });
        });
        const validCategoryIds = new Set(
          merged.map((group, gi) =>
            String(group?.category_id || `group_${gi}`),
          ),
        );
        const seenContentIds = new Set();
        merged.forEach((group, gi) => {
          const categoryId = String(group?.category_id || `group_${gi}`);
          group.items = (group.items || []).filter((article) => {
            const contentId = article?.content_id;
            if (!contentId) return true;
            const preferredCategory = preferredCategoryByContentId.get(contentId);
            if (
              preferredCategory &&
              validCategoryIds.has(preferredCategory) &&
              preferredCategory !== categoryId
            ) {
              return false;
            }
            if (seenContentIds.has(contentId)) return false;
            seenContentIds.add(contentId);
            return true;
          });
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
        clearMoveUndoState();
        let t = $("#toast");
        t.classList.remove("move-toast");
        t.textContent = s;
        t.classList.add("show");
        clearTimeout(window.tt);
        window.tt = setTimeout(() => t.classList.remove("show"), 1200);
      }
      function clearMoveUndoState() {
        clearTimeout(window.moveUndoTimer);
        latestMoveUndo = null;
      }
      function showMoveSuccessToast(targetTitle, undoState) {
        clearTimeout(window.tt);
        clearTimeout(window.moveUndoTimer);
        latestMoveUndo = undoState;
        const t = $("#toast");
        t.classList.add("show", "move-toast");
        t.innerHTML = `<span>已移动到“${esc(targetTitle)}”</span><button type="button" onclick="undoLastArticleMove()">撤销</button>`;
        window.moveUndoTimer = setTimeout(() => {
          latestMoveUndo = null;
          t.classList.remove("show", "move-toast");
        }, 8000);
      }
      function ensureMoveDialog() {
        let backdrop = $("#moveArticleDialog");
        if (backdrop) return backdrop;
        backdrop = document.createElement("div");
        backdrop.id = "moveArticleDialog";
        backdrop.className = "move-dialog-backdrop";
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        backdrop.innerHTML = `<section class="move-dialog" role="dialog" aria-modal="true" aria-labelledby="moveDialogTitle"><header><h2 id="moveDialogTitle">移动内容</h2><button type="button" class="move-dialog-close" aria-label="关闭移动内容窗口" title="关闭" onclick="closeMoveDialog()">×</button></header><div class="move-dialog-summary"><span>当前文章</span><strong id="moveArticleTitle"></strong><span>当前分类</span><strong id="moveCurrentCategory"></strong></div><label class="move-dialog-field"><span>目标分类</span><select id="moveTargetCategory" onchange="updateMoveConfirmButton()"><option value="">请选择目标分类</option></select></label><footer><button type="button" class="btn" onclick="closeMoveDialog()">取消</button><button type="button" class="btn primary" id="confirmArticleMove" onclick="confirmArticleMove()" disabled>确认移动</button></footer></section>`;
        backdrop.addEventListener("click", (event) => {
          if (event.target === backdrop) closeMoveDialog();
        });
        document.body.appendChild(backdrop);
        return backdrop;
      }
      function openMoveDialog() {
        if (mode !== "group") return;
        if (editing) {
          toast("请先完成编辑再移动");
          return;
        }
        const article = groups[activeG]?.items?.[activeI];
        const sourceGroup = groups[activeG];
        if (!article || !sourceGroup) return;
        const contentId = ensureStableContentId(activeG, activeI);
        if (!contentId) return;
        const sourceCategoryId = getCategoryOrderId(sourceGroup, activeG);
        const targetGroups = getOrderedGroupIndexes().filter(
          (gi) => gi !== activeG && groups[gi],
        );
        if (!targetGroups.length) {
          toast("暂无可移动的目标分类");
          return;
        }
        const backdrop = ensureMoveDialog();
        moveDialogReturnFocus = document.activeElement;
        $("#moveArticleTitle").textContent = article.title;
        $("#moveCurrentCategory").textContent = sourceGroup.title;
        const select = $("#moveTargetCategory");
        select.innerHTML = `<option value="">请选择目标分类</option>${targetGroups
          .map(
            (gi) =>
              `<option value="${esc(getCategoryOrderId(groups[gi], gi))}">${esc(groups[gi].title)}</option>`,
          )
          .join("")}`;
        backdrop.dataset.contentId = contentId;
        backdrop.dataset.sourceCategoryId = sourceCategoryId;
        $("#confirmArticleMove").disabled = true;
        backdrop.hidden = false;
        backdrop.setAttribute("aria-hidden", "false");
        document.body.classList.add("moving-content");
        requestAnimationFrame(() => select.focus());
      }
      function updateMoveConfirmButton() {
        const backdrop = $("#moveArticleDialog");
        const select = $("#moveTargetCategory");
        const confirmButton = $("#confirmArticleMove");
        if (!backdrop || !select || !confirmButton) return;
        confirmButton.disabled =
          !select.value ||
          select.value === backdrop.dataset.sourceCategoryId ||
          findGroupIndexByCategoryId(select.value) < 0;
      }
      function closeMoveDialog() {
        const backdrop = $("#moveArticleDialog");
        if (!backdrop || backdrop.hidden) return;
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        delete backdrop.dataset.contentId;
        delete backdrop.dataset.sourceCategoryId;
        document.body.classList.remove("moving-content");
        const returnFocus = moveDialogReturnFocus;
        moveDialogReturnFocus = null;
        returnFocus?.focus?.();
      }
      function renderMovedArticle(groupIndex) {
        activeG = groupIndex;
        activeI = 0;
        editing = false;
        setMode("group");
        renderNav(groupIndex);
        renderGroupList(groupIndex);
        renderDoc();
      }
      function confirmArticleMove() {
        const backdrop = $("#moveArticleDialog");
        const select = $("#moveTargetCategory");
        if (!backdrop || backdrop.hidden || !select?.value) return;
        const contentId = String(backdrop.dataset.contentId || "");
        const current = findArticleByContentId(contentId);
        const targetIndex = findGroupIndexByCategoryId(select.value);
        if (!current || targetIndex < 0 || current.gi === targetIndex) {
          updateMoveConfirmButton();
          return;
        }
        const sourceCategoryId = getCategoryOrderId(groups[current.gi], current.gi);
        const targetCategoryId = getCategoryOrderId(
          groups[targetIndex],
          targetIndex,
        );
        const previousOverride = articleCategoryOverrides[contentId]
          ? structuredClone(articleCategoryOverrides[contentId])
          : null;
        articleCategoryOverrides[contentId] = {
          content_id: contentId,
          source_category_id:
            previousOverride?.source_category_id || sourceCategoryId,
          target_category_id: targetCategoryId,
          moved_at: new Date().toISOString(),
        };
        if (!persistArticleCategoryOverrides()) {
          if (previousOverride) {
            articleCategoryOverrides[contentId] = previousOverride;
          } else {
            delete articleCategoryOverrides[contentId];
          }
          return;
        }
        const result = relocateArticleByContentId(contentId, targetCategoryId);
        if (!result) {
          if (previousOverride) {
            articleCategoryOverrides[contentId] = previousOverride;
          } else {
            delete articleCategoryOverrides[contentId];
          }
          persistArticleCategoryOverrides();
          toast("移动失败，文章或目标分类不存在");
          return;
        }
        const sourceTitle = groups[current.gi]?.title || "原分类";
        const targetTitle = groups[targetIndex].title;
        closeMoveDialog();
        renderMovedArticle(targetIndex);
        showMoveSuccessToast(targetTitle, {
          contentId,
          sourceCategoryId,
          sourceTitle,
          targetCategoryId,
          previousOverride,
        });
      }
      function undoLastArticleMove() {
        const state = latestMoveUndo;
        if (!state) return;
        const currentOverride = articleCategoryOverrides[state.contentId];
        if (
          !currentOverride ||
          currentOverride.target_category_id !== state.targetCategoryId ||
          findGroupIndexByCategoryId(state.sourceCategoryId) < 0 ||
          !findArticleByContentId(state.contentId)
        ) {
          toast("当前移动无法撤销");
          return;
        }
        clearTimeout(window.moveUndoTimer);
        latestMoveUndo = null;
        if (state.previousOverride) {
          articleCategoryOverrides[state.contentId] = structuredClone(
            state.previousOverride,
          );
        } else {
          delete articleCategoryOverrides[state.contentId];
        }
        if (!persistArticleCategoryOverrides()) {
          articleCategoryOverrides[state.contentId] = currentOverride;
          return;
        }
        const result = relocateArticleByContentId(
          state.contentId,
          state.sourceCategoryId,
        );
        if (!result) {
          articleCategoryOverrides[state.contentId] = currentOverride;
          persistArticleCategoryOverrides();
          toast("当前移动无法撤销");
          return;
        }
        renderMovedArticle(result.targetIndex);
        toast("已撤销移动");
      }
      function loadCategoryOrder() {
        try {
          const parsed = JSON.parse(
            localStorage.getItem(CATEGORY_ORDER_KEY) || "[]",
          );
          if (!Array.isArray(parsed)) return [];
          const seen = new Set();
          return parsed
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter((value) => {
              if (!value || seen.has(value)) return false;
              seen.add(value);
              return true;
            });
        } catch (error) {
          return [];
        }
      }
      function getCategoryOrderId(group, index) {
        return String(group?.category_id || `group_${index}`);
      }
      function getOrderedGroupIndexes() {
        const ordered = [];
        const used = new Set();
        categoryOrder.forEach((categoryId) => {
          const index = groups.findIndex(
            (group, gi) =>
              !used.has(gi) &&
              getCategoryOrderId(group, gi) === categoryId,
          );
          if (index < 0) return;
          used.add(index);
          ordered.push(index);
        });
        groups.forEach((group, gi) => {
          if (!used.has(gi)) ordered.push(gi);
        });
        return ordered;
      }
      function persistCategoryOrder(indexes) {
        const seen = new Set();
        categoryOrder = indexes
          .map((gi) => getCategoryOrderId(groups[gi], gi))
          .filter((categoryId) => {
            if (!categoryId || seen.has(categoryId)) return false;
            seen.add(categoryId);
            return true;
          });
        try {
          localStorage.setItem(
            CATEGORY_ORDER_KEY,
            JSON.stringify(categoryOrder),
          );
          return true;
        } catch (error) {
          toast("分类顺序保存失败");
          return false;
        }
      }
      function createCategoryId() {
        let categoryId = "";
        do {
          const suffix =
            globalThis.crypto?.randomUUID?.().replace(/-/g, "") ||
            `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
          categoryId = `category_user_${suffix}`;
        } while (
          groups.some((group, gi) =>
            getCategoryOrderId(group, gi) === categoryId
          )
        );
        return categoryId;
      }
      function isCompactSidebar() {
        return window.matchMedia("(max-width: 950px)").matches;
      }
      function updateCategoryScrollControls() {
        const section = $(".category-section");
        const scroller = $("#categoryScroll");
        if (!section || !scroller) return;
        const overflow =
          !isCompactSidebar() &&
          scroller.scrollHeight > scroller.clientHeight + 2;
        const canScrollUp = overflow && scroller.scrollTop > 1;
        const canScrollDown =
          overflow &&
          scroller.scrollTop + scroller.clientHeight <
            scroller.scrollHeight - 1;
        section.classList.toggle("has-overflow", overflow);
        const up = $(".category-scroll-up");
        const down = $(".category-scroll-down");
        up?.classList.toggle("can-scroll", canScrollUp);
        down?.classList.toggle("can-scroll", canScrollDown);
        if (up) up.disabled = !canScrollUp;
        if (down) down.disabled = !canScrollDown;
      }
      function scrollCategoryList(direction) {
        const scroller = $("#categoryScroll");
        if (!scroller || isCompactSidebar()) return;
        scroller.scrollBy({
          top:
            Math.sign(direction) *
            Math.max(110, Math.round(scroller.clientHeight * 0.58)),
          behavior: "smooth",
        });
      }
      function keepCategoryVisible(groupIndex) {
        const row = document.querySelector(
          `.category-row[data-group-index="${groupIndex}"]`,
        );
        if (!row) return;
        const scroller = isCompactSidebar()
          ? $(".sidebar")
          : $("#categoryScroll");
        if (!scroller) return;
        const rowRect = row.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        if (isCompactSidebar()) {
          if (rowRect.left < scrollerRect.left) {
            scroller.scrollLeft -= scrollerRect.left - rowRect.left;
          } else if (rowRect.right > scrollerRect.right) {
            scroller.scrollLeft += rowRect.right - scrollerRect.right;
          }
        } else if (rowRect.top < scrollerRect.top) {
          scroller.scrollTop -= scrollerRect.top - rowRect.top;
        } else if (rowRect.bottom > scrollerRect.bottom) {
          scroller.scrollTop += rowRect.bottom - scrollerRect.bottom;
        }
        updateCategoryScrollControls();
      }
      function initCategoryScroller() {
        const scroller = $("#categoryScroll");
        const cats = $("#cats");
        if (!scroller || !cats) return;
        scroller.addEventListener("scroll", updateCategoryScrollControls, {
          passive: true,
        });
        if (typeof ResizeObserver === "function") {
          categoryScrollObserver?.disconnect();
          categoryScrollObserver = new ResizeObserver(
            updateCategoryScrollControls,
          );
          categoryScrollObserver.observe(scroller);
          categoryScrollObserver.observe(cats);
        }
        updateCategoryScrollControls();
      }
      function clearCategoryDropIndicators() {
        document
          .querySelectorAll(
            ".category-row.is-dragging, .category-row.drop-before, .category-row.drop-after",
          )
          .forEach((row) =>
            row.classList.remove(
              "is-dragging",
              "drop-before",
              "drop-after",
            ),
          );
      }
      function activateCategoryDrag() {
        if (!categoryDragState || categoryDragState.active) return;
        categoryDragState.active = true;
        categoryDragState.handle.setAttribute("aria-grabbed", "true");
        document
          .querySelector(
            `.category-row[data-group-index="${categoryDragState.sourceIndex}"]`,
          )
          ?.classList.add("is-dragging");
      }
      function startCategoryDrag(event, groupIndex) {
        if (
          (event.pointerType === "mouse" && event.button !== 0) ||
          categoryDragState
        ) {
          return;
        }
        event.stopPropagation();
        if (event.pointerType === "mouse") event.preventDefault();
        const handle = event.currentTarget;
        categoryDragState = {
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          handle,
          sourceIndex: groupIndex,
          targetIndex: null,
          after: false,
          active: false,
          startX: event.clientX,
          startY: event.clientY,
          timer: null,
        };
        handle.setPointerCapture?.(event.pointerId);
        if (event.pointerType === "touch") {
          categoryDragState.timer = setTimeout(activateCategoryDrag, 320);
        } else {
          activateCategoryDrag();
        }
      }
      function updateCategoryDropTarget(clientX, clientY) {
        if (!categoryDragState?.active) return;
        const rows = [...document.querySelectorAll(".category-row")];
        if (!rows.length) return;
        const horizontal = isCompactSidebar();
        const pointerPosition = horizontal ? clientX : clientY;
        const target = rows.reduce((nearest, row) => {
          const rect = row.getBoundingClientRect();
          const center = horizontal
            ? rect.left + rect.width / 2
            : rect.top + rect.height / 2;
          const distance = Math.abs(pointerPosition - center);
          return !nearest || distance < nearest.distance
            ? { row, rect, center, distance }
            : nearest;
        }, null);
        clearCategoryDropIndicators();
        document
          .querySelector(
            `.category-row[data-group-index="${categoryDragState.sourceIndex}"]`,
          )
          ?.classList.add("is-dragging");
        const targetIndex = Number(target.row.dataset.groupIndex);
        if (
          !Number.isInteger(targetIndex) ||
          targetIndex === categoryDragState.sourceIndex
        ) {
          categoryDragState.targetIndex = null;
          return;
        }
        const after = pointerPosition > target.center;
        categoryDragState.targetIndex = targetIndex;
        categoryDragState.after = after;
        target.row.classList.add(after ? "drop-after" : "drop-before");
      }
      function autoScrollCategories(clientX, clientY) {
        if (!categoryDragState?.active) return;
        const scroller = isCompactSidebar()
          ? $(".sidebar")
          : $("#categoryScroll");
        if (!scroller) return;
        const rect = scroller.getBoundingClientRect();
        const horizontal = isCompactSidebar();
        const position = horizontal ? clientX : clientY;
        const start = horizontal ? rect.left : rect.top;
        const end = horizontal ? rect.right : rect.bottom;
        const edge = Math.min(44, (end - start) / 4);
        let delta = 0;
        if (position < start + edge) delta = -14;
        else if (position > end - edge) delta = 14;
        if (!delta) return;
        scroller.scrollBy(
          horizontal ? { left: delta } : { top: delta },
        );
        updateCategoryScrollControls();
      }
      function handleCategoryPointerMove(event) {
        if (
          !categoryDragState ||
          event.pointerId !== categoryDragState.pointerId
        ) {
          return;
        }
        if (!categoryDragState.active) {
          const distance = Math.hypot(
            event.clientX - categoryDragState.startX,
            event.clientY - categoryDragState.startY,
          );
          if (distance > 10) finishCategoryDrag(event, false);
          return;
        }
        event.preventDefault();
        autoScrollCategories(event.clientX, event.clientY);
        updateCategoryDropTarget(event.clientX, event.clientY);
      }
      function moveCategory(sourceIndex, targetIndex, after) {
        const order = getOrderedGroupIndexes();
        const sourcePosition = order.indexOf(sourceIndex);
        if (sourcePosition < 0 || !order.includes(targetIndex)) return;
        order.splice(sourcePosition, 1);
        const targetPosition = order.indexOf(targetIndex);
        order.splice(targetPosition + (after ? 1 : 0), 0, sourceIndex);
        const saved = persistCategoryOrder(order);
        renderNav(
          (mode === "group" || mode === "gallery") ? activeG : sourceIndex,
        );
        if (saved) toast("分类顺序已保存");
      }
      function finishCategoryDrag(event, commit = true) {
        if (
          !categoryDragState ||
          (event?.pointerId != null &&
            event.pointerId !== categoryDragState.pointerId)
        ) {
          return;
        }
        const state = categoryDragState;
        clearTimeout(state.timer);
        if (
          commit &&
          state.active &&
          Number.isInteger(state.targetIndex)
        ) {
          moveCategory(
            state.sourceIndex,
            state.targetIndex,
            state.after,
          );
        }
        state.handle.setAttribute("aria-grabbed", "false");
        if (state.handle.hasPointerCapture?.(state.pointerId)) {
          state.handle.releasePointerCapture(state.pointerId);
        }
        categoryDragState = null;
        clearCategoryDropIndicators();
      }
      function handleCategoryHandleKeydown(event, groupIndex) {
        const backward = ["ArrowUp", "ArrowLeft"].includes(event.key);
        const forward = ["ArrowDown", "ArrowRight"].includes(event.key);
        if (!backward && !forward) return;
        event.preventDefault();
        event.stopPropagation();
        const order = getOrderedGroupIndexes();
        const position = order.indexOf(groupIndex);
        const nextPosition = position + (backward ? -1 : 1);
        if (position < 0 || nextPosition < 0 || nextPosition >= order.length) {
          return;
        }
        moveCategory(
          groupIndex,
          order[nextPosition],
          forward,
        );
        requestAnimationFrame(() =>
          document
            .querySelector(
              `.category-row[data-group-index="${groupIndex}"] .category-drag-handle`,
            )
            ?.focus(),
        );
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
        if (m !== "gallery") {
          closeGalleryMenus();
          clearGalleryThumbnailUrls();
          closeGalleryUploadDialog(true);
        }
        mode = m;
        document
          .querySelector(".app")
          ?.classList.toggle("gallery-mode", m === "gallery");
        document
          .querySelectorAll(".navbtn[data-mode]")
          .forEach((x) => x.classList.toggle("on", x.dataset.mode === m));
      }
      function renderNav(visibleGroupIndex = null) {
        let total = 0;
        $("#cats").innerHTML = getOrderedGroupIndexes()
          .map((gi) => {
            const g = groups[gi];
            total += g.items.length;
            const label = `拖动调整“${g.title}”分类顺序`;
            return `<div class="category-row" data-group-index="${gi}" data-category-id="${esc(getCategoryOrderId(g, gi))}"><button type="button" class="navbtn category-open ${(mode === "group" || mode === "gallery") && gi === activeG ? "on" : ""}" onclick="openGroup(${gi})"><span class="category-name">📁 ${esc(g.title)}</span><em>${g.items.length}</em></button><button type="button" class="category-drag-handle" aria-label="${esc(label)}" title="拖动调整分类顺序" aria-grabbed="false" onpointerdown="startCategoryDrag(event,${gi})" onkeydown="handleCategoryHandleKeydown(event,${gi})" onclick="event.preventDefault();event.stopPropagation()">⠿</button></div>`;
          })
          .join("");
        $("#favCount").textContent = favs.length;
        requestAnimationFrame(() => {
          updateCategoryScrollControls();
          const targetIndex =
            visibleGroupIndex ??
            ((mode === "group" || mode === "gallery") ? activeG : null);
          if (Number.isInteger(targetIndex)) keepCategoryVisible(targetIndex);
        });
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
          `<div class="topbar"><div class="crumb">${esc(groups[activeG].title)} / ${editing ? "编辑内容" : "查看内容"}</div><div class="tools"><button class="btn" onclick="toggleFav(${activeG},${activeI})">${favs.includes(getContentId(activeG, activeI)) ? "★ 已收藏" : "☆ 收藏"}</button><button class="btn" onclick="copyCurrent()">复制</button><button class="btn" onclick="openMoveDialog()" ${editing ? 'disabled title="请先完成编辑再移动"' : ""}>移动</button><button class="btn primary" onclick="toggleEdit()">${editing ? "完成编辑" : "编辑"}</button><button class="btn danger" onclick="deleteCurrent()">删除</button></div></div><div class="paper">${editing ? `<div class="article-editor"><input class="titleinput" id="titleEdit" value="${esc(x.title)}"><textarea class="contentarea" id="bodyEdit">${esc(text)}</textarea>${renderImageManager(activeG, activeI)}</div>` : `<h1 style="margin:0;border-bottom:1px solid var(--line);padding-bottom:12px">${esc(x.title)}</h1>${images}${body}`}</div>`;
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
        groups.push({
          title: n,
          category_id: createCategoryId(),
          items: [],
        });
        persistCategoryOrder(getOrderedGroupIndexes());
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
              hydrateGroups();
              applyArticleCategoryOverrides();
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
          hydrateGroups();
          applyArticleCategoryOverrides();
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
          closeGalleryUploadDialog();
          closeMoveDialog();
        }
      });
      document.addEventListener("paste", handlePriceGalleryPaste);
      document.addEventListener("click", (event) => {
        if (!event.target.closest(".gallery-more")) closeGalleryMenus();
      });
      window.addEventListener("resize", () => closeGalleryMenus());
      window.addEventListener("resize", updateCategoryScrollControls);
      document.addEventListener("pointermove", handleCategoryPointerMove, {
        passive: false,
      });
      document.addEventListener("pointerup", (event) =>
        finishCategoryDrag(event),
      );
      document.addEventListener("pointercancel", (event) =>
        finishCategoryDrag(event, false),
      );
      $(".main")?.addEventListener("scroll", () => {
        const openMenu = document.querySelector(".gallery-more[open]");
        if (openMenu) {
          requestAnimationFrame(() => positionGalleryMenu(openMenu));
        }
      });
      initCategoryScroller();
      renderNav();
      showHome();
