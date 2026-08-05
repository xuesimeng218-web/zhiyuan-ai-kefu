const KEY = "zy_kb_system_v2",
        FKEY = "zy_kb_favs_v2",
        RKEY = "zy_kb_recent_v2",
        IKEY = "zy_kb_article_images_v2",
        CATEGORY_ORDER_KEY = "zy_kb_category_order_v1",
        ARTICLE_ORDER_KEY = "zy_kb_article_order_v1",
        ARTICLE_CATEGORY_OVERRIDE_KEY = "zy_kb_article_category_overrides_v1",
        UI_STATE_KEY = "zy_kb_ui_state_v1",
        PRICE_GALLERY_META_KEY = "zy_kb_price_gallery_meta_v1",
        PRICE_GALLERY_DB_NAME = "zy_kb_price_gallery_db",
        PRICE_GALLERY_DB_VERSION = 2,
        PRICE_GALLERY_IMAGE_STORE = "images",
        PRICE_GALLERY_THUMBNAIL_STORE = "thumbnails",
        PRICE_GALLERY_VERSION_STORE = "versions",
        PRICE_GALLERY_VERSION_THUMBNAIL_STORE = "versionThumbnails",
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
      let articleOrder = loadArticleOrder();
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
      let activeArticleVisible = false;
      let uiStateRestoring = false;
      let uiStateSaveTimer = null;
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
      const PRICE_GALLERY_BACKUP_TYPE = "zy-kb-price-gallery-backup";
      const PRICE_GALLERY_BACKUP_SCHEMA_VERSION = 2;
      const PRICE_GALLERY_BACKUP_SUPPORTED_VERSIONS = new Set([1, 2]);
      const PRICE_GALLERY_BACKUP_MAX_BYTES = 256 * 1024 * 1024;
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
      let galleryMetaLoadError = false;
      let priceGalleryMeta = loadPriceGalleryMeta();
      let priceGalleryDbPromise = null;
      let galleryUploadState = null;
      let galleryUploadBusy = false;
      let galleryStorageBusy = "";
      let galleryViewerUrl = "";
      let galleryViewerRequestToken = 0;
      let galleryThumbnailRenderToken = 0;
      let galleryEditState = null;
      let galleryReplaceState = null;
      let galleryVersionDialogState = null;
      let galleryLegacyMigrationStarted = false;
      let galleryAssetDragState = null;
      const galleryThumbnailUrls = new Map();
      const galleryViewState = {
        query: "",
        product: "all",
        status: "all",
        sort: "custom",
      };
      let categoryDragState = null;
      let articleDragState = null;
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
        renderList(getOrderedArticleRecords(gi), group.title);
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
        if (error?.name === "TransactionInactiveError" || error?.name === "AbortError") {
          return "IDB_TRANSACTION_FAILED";
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
          IDB_WRITE_FAILED:
            "IndexedDB 写入失败，现有图片保持不变，请重试。",
          IDB_TRANSACTION_FAILED:
            "数据库事务失败，未完成的数据变更已停止。",
          STORAGE_FULL:
            "浏览器存储空间不足，请释放本机浏览器空间后重试。",
          META_SAVE_FAILED:
            "价格图元数据保存失败，现有数据保持不变，请重试。",
          NO_CLIPBOARD_IMAGE: "剪贴板中未检测到图片。",
          CLIPBOARD_UNSUPPORTED:
            "当前浏览器不支持复制图片，请使用下载功能。",
          IMAGE_NOT_FOUND: "图片数据暂时无法读取，元数据仍然保留。",
          BACKUP_NOT_JSON: "备份文件不是有效的 JSON 文件。",
          BACKUP_TYPE_INVALID: "备份类型错误，不是价格图库备份。",
          BACKUP_STRUCTURE_INVALID: "备份结构或字段不完整。",
          BACKUP_IMAGE_CORRUPT: "备份中的图片数据已损坏。",
          MIGRATION_FAILED: "旧价格图迁移失败，原始 Base64 数据已保留。",
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
          deletedAt: String(raw.deletedAt || ""),
        };
      }
      function loadPriceGalleryMeta() {
        try {
          const parsed = JSON.parse(
            localStorage.getItem(PRICE_GALLERY_META_KEY) || "[]",
          );
          if (!Array.isArray(parsed)) {
            galleryMetaLoadError = true;
            return [];
          }
          const seen = new Set();
          const normalized = [];
          parsed.forEach((raw, index) => {
            const asset = sanitizeGalleryMeta(raw, index);
            if (!asset || seen.has(asset.assetId)) {
              galleryMetaLoadError = true;
              return;
            }
            seen.add(asset.assetId);
            normalized.push(asset);
          });
          return normalized;
        } catch (error) {
          galleryMetaLoadError = true;
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
          galleryMetaLoadError = false;
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
      function ensurePriceGalleryMetaWritable() {
        if (!galleryMetaLoadError) return true;
        alert(
          "价格图元数据存在异常。为避免覆盖现有记录，本次修改未保存；请先备份并检查浏览器数据。",
        );
        return false;
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
            if (!db.objectStoreNames.contains(PRICE_GALLERY_VERSION_STORE)) {
              const store = db.createObjectStore(PRICE_GALLERY_VERSION_STORE, {
                keyPath: "versionId",
              });
              store.createIndex("assetId", "assetId", { unique: false });
            }
            if (
              !db.objectStoreNames.contains(
                PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
              )
            ) {
              const store = db.createObjectStore(
                PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
                { keyPath: "versionId" },
              );
              store.createIndex("assetId", "assetId", { unique: false });
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
                galleryErrorCode(transaction.error, "IDB_TRANSACTION_FAILED"),
                transaction.error,
              ),
            );
          transaction.onabort = () =>
            reject(
              createGalleryError(
                galleryErrorCode(transaction.error, "IDB_TRANSACTION_FAILED"),
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
                galleryErrorCode(request.error, "IDB_TRANSACTION_FAILED"),
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
            galleryErrorCode(error, "IDB_WRITE_FAILED"),
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
      function createPriceGalleryVersionId() {
        const random =
          globalThis.crypto?.randomUUID?.().replace(/-/g, "") ||
          Math.random().toString(36).slice(2) + Date.now().toString(36);
        return `price_version_${random}`;
      }
      function makeGalleryVersionRecord(
        currentRecord,
        versionId,
        assetId,
        createdAt,
        metadata,
      ) {
        return {
          versionId,
          assetId,
          blob: currentRecord.blob,
          width: currentRecord.width,
          height: currentRecord.height,
          size: currentRecord.size,
          mimeType: currentRecord.mimeType || currentRecord.blob.type,
          createdAt,
          originalName: metadata.originalName || "",
          originalType: metadata.originalType || "",
          originalSize: metadata.originalSize || 0,
        };
      }
      async function getPriceGalleryVersions(assetId) {
        const db = await openPriceGalleryDb();
        try {
          const transaction = db.transaction(
            [
              PRICE_GALLERY_VERSION_STORE,
              PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
            ],
            "readonly",
          );
          const [images, thumbnails] = await Promise.all([
            galleryRequest(
              transaction
                .objectStore(PRICE_GALLERY_VERSION_STORE)
                .index("assetId")
                .getAll(assetId),
            ),
            galleryRequest(
              transaction
                .objectStore(PRICE_GALLERY_VERSION_THUMBNAIL_STORE)
                .index("assetId")
                .getAll(assetId),
            ),
          ]);
          const thumbnailById = new Map(
            thumbnails.map((record) => [record.versionId, record]),
          );
          const imageById = new Map(
            images.map((record) => [record.versionId, record]),
          );
          return [...new Set([...imageById.keys(), ...thumbnailById.keys()])]
            .map((versionId) => ({
              image: imageById.get(versionId) || null,
              thumbnail: thumbnailById.get(versionId) || null,
            }))
            .sort(
              (a, b) =>
                galleryTimestamp(
                  b.image?.createdAt || b.thumbnail?.createdAt,
                ) -
                galleryTimestamp(
                  a.image?.createdAt || a.thumbnail?.createdAt,
                ),
            );
        } catch (error) {
          throw createGalleryError(
            galleryErrorCode(error, "IDB_TRANSACTION_FAILED"),
            error,
          );
        }
      }
      async function getPriceGalleryVersionRecord(storeName, versionId) {
        return getPriceGalleryBlobRecord(storeName, versionId);
      }
      async function replacePriceGalleryBlobRecords(
        asset,
        processed,
        file,
        versionId,
        replacedAt,
      ) {
        const [oldImage, oldThumbnail] = await Promise.all([
          getPriceGalleryBlobRecord(PRICE_GALLERY_IMAGE_STORE, asset.assetId),
          getPriceGalleryBlobRecord(
            PRICE_GALLERY_THUMBNAIL_STORE,
            asset.assetId,
          ),
        ]);
        if (
          !(oldImage?.blob instanceof Blob) ||
          !(oldThumbnail?.blob instanceof Blob)
        ) {
          throw createGalleryError("IMAGE_NOT_FOUND");
        }
        const oldVersionImage = makeGalleryVersionRecord(
          oldImage,
          versionId,
          asset.assetId,
          replacedAt,
          asset,
        );
        const oldVersionThumbnail = makeGalleryVersionRecord(
          oldThumbnail,
          versionId,
          asset.assetId,
          replacedAt,
          asset,
        );
        const newImage = {
          assetId: asset.assetId,
          blob: processed.full.blob,
          width: processed.full.width,
          height: processed.full.height,
          size: processed.full.blob.size,
          mimeType: "image/webp",
        };
        const newThumbnail = {
          assetId: asset.assetId,
          blob: processed.thumbnail.blob,
          width: processed.thumbnail.width,
          height: processed.thumbnail.height,
          size: processed.thumbnail.blob.size,
          mimeType: "image/webp",
        };
        const db = await openPriceGalleryDb();
        try {
          const transaction = db.transaction(
            [
              PRICE_GALLERY_IMAGE_STORE,
              PRICE_GALLERY_THUMBNAIL_STORE,
              PRICE_GALLERY_VERSION_STORE,
              PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
            ],
            "readwrite",
          );
          transaction
            .objectStore(PRICE_GALLERY_VERSION_STORE)
            .add(oldVersionImage);
          transaction
            .objectStore(PRICE_GALLERY_VERSION_THUMBNAIL_STORE)
            .add(oldVersionThumbnail);
          transaction.objectStore(PRICE_GALLERY_IMAGE_STORE).put(newImage);
          transaction
            .objectStore(PRICE_GALLERY_THUMBNAIL_STORE)
            .put(newThumbnail);
          await waitForGalleryTransaction(transaction);
        } catch (error) {
          throw createGalleryError(
            galleryErrorCode(error, "IDB_WRITE_FAILED"),
            error,
          );
        }
        return {
          oldImage,
          oldThumbnail,
          oldVersionImage,
          oldVersionThumbnail,
          newImage,
          newThumbnail,
          file,
        };
      }
      async function rollbackPriceGalleryReplacement(assetId, snapshot) {
        const db = await openPriceGalleryDb();
        const transaction = db.transaction(
          [
            PRICE_GALLERY_IMAGE_STORE,
            PRICE_GALLERY_THUMBNAIL_STORE,
            PRICE_GALLERY_VERSION_STORE,
            PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
          ],
          "readwrite",
        );
        transaction
          .objectStore(PRICE_GALLERY_IMAGE_STORE)
          .put(snapshot.oldImage);
        transaction
          .objectStore(PRICE_GALLERY_THUMBNAIL_STORE)
          .put(snapshot.oldThumbnail);
        transaction
          .objectStore(PRICE_GALLERY_VERSION_STORE)
          .delete(snapshot.oldVersionImage.versionId);
        transaction
          .objectStore(PRICE_GALLERY_VERSION_THUMBNAIL_STORE)
          .delete(snapshot.oldVersionThumbnail.versionId);
        await waitForGalleryTransaction(transaction);
        await verifyPriceGalleryBlobs(assetId);
      }
      async function getPriceGalleryStoredIds() {
        const db = await openPriceGalleryDb();
        try {
          const transaction = db.transaction(
            [PRICE_GALLERY_IMAGE_STORE, PRICE_GALLERY_THUMBNAIL_STORE],
            "readonly",
          );
          const [imageIds, thumbnailIds] = await Promise.all([
            galleryRequest(
              transaction.objectStore(PRICE_GALLERY_IMAGE_STORE).getAllKeys(),
            ),
            galleryRequest(
              transaction
                .objectStore(PRICE_GALLERY_THUMBNAIL_STORE)
                .getAllKeys(),
            ),
          ]);
          return { imageIds, thumbnailIds };
        } catch (error) {
          throw createGalleryError(
            galleryErrorCode(error, "IDB_UNAVAILABLE"),
            error,
          );
        }
      }
      async function getPriceGalleryStoredVersionIds() {
        const db = await openPriceGalleryDb();
        const transaction = db.transaction(
          [
            PRICE_GALLERY_VERSION_STORE,
            PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
          ],
          "readonly",
        );
        const [imageIds, thumbnailIds] = await Promise.all([
          galleryRequest(
            transaction.objectStore(PRICE_GALLERY_VERSION_STORE).getAllKeys(),
          ),
          galleryRequest(
            transaction
              .objectStore(PRICE_GALLERY_VERSION_THUMBNAIL_STORE)
              .getAllKeys(),
          ),
        ]);
        return { imageIds, thumbnailIds };
      }
      async function addPriceGalleryRestoreRecords(assets, versions = []) {
        if (!assets.length && !versions.length) return;
        const db = await openPriceGalleryDb();
        const transaction = db.transaction(
          [
            PRICE_GALLERY_IMAGE_STORE,
            PRICE_GALLERY_THUMBNAIL_STORE,
            PRICE_GALLERY_VERSION_STORE,
            PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
          ],
          "readwrite",
        );
        const imageStore = transaction.objectStore(PRICE_GALLERY_IMAGE_STORE);
        const thumbnailStore = transaction.objectStore(
          PRICE_GALLERY_THUMBNAIL_STORE,
        );
        assets.forEach((asset) => {
          imageStore.add(asset.image);
          thumbnailStore.add(asset.thumbnail);
        });
        const versionStore = transaction.objectStore(
          PRICE_GALLERY_VERSION_STORE,
        );
        const versionThumbnailStore = transaction.objectStore(
          PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
        );
        versions.forEach((version) => {
          versionStore.add(version.image);
          versionThumbnailStore.add(version.thumbnail);
        });
        await waitForGalleryTransaction(transaction);
      }
      async function deletePriceGalleryRestoreRecords(
        assetIds,
        versionIds = [],
      ) {
        if (!assetIds.length && !versionIds.length) return;
        const db = await openPriceGalleryDb();
        const transaction = db.transaction(
          [
            PRICE_GALLERY_IMAGE_STORE,
            PRICE_GALLERY_THUMBNAIL_STORE,
            PRICE_GALLERY_VERSION_STORE,
            PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
          ],
          "readwrite",
        );
        const imageStore = transaction.objectStore(PRICE_GALLERY_IMAGE_STORE);
        const thumbnailStore = transaction.objectStore(
          PRICE_GALLERY_THUMBNAIL_STORE,
        );
        assetIds.forEach((assetId) => {
          imageStore.delete(assetId);
          thumbnailStore.delete(assetId);
        });
        versionIds.forEach((versionId) => {
          transaction
            .objectStore(PRICE_GALLERY_VERSION_STORE)
            .delete(versionId);
          transaction
            .objectStore(PRICE_GALLERY_VERSION_THUMBNAIL_STORE)
            .delete(versionId);
        });
        await waitForGalleryTransaction(transaction);
      }
      async function checkPriceGalleryRestoreSpace(assets, versions = []) {
        if (!navigator.storage?.estimate || (!assets.length && !versions.length)) {
          return;
        }
        let estimate;
        try {
          estimate = await navigator.storage.estimate();
        } catch (error) {
          return;
        }
        const quota = Number(estimate?.quota);
        const usage = Number(estimate?.usage);
        if (!Number.isFinite(quota) || !Number.isFinite(usage)) return;
        const requiredBytes = assets.reduce(
          (total, asset) =>
            total +
            asset.image.blob.size +
            asset.thumbnail.blob.size +
            (asset.versions || []).reduce(
              (versionTotal, version) =>
                versionTotal +
                version.image.blob.size +
                version.thumbnail.blob.size,
              0,
            ),
          0,
        ) + versions.reduce(
          (total, version) =>
            total + version.image.blob.size + version.thumbnail.blob.size,
          0,
        );
        const safetyMargin = Math.max(2 * 1024 * 1024, requiredBytes * 0.15);
        if (quota - usage < requiredBytes + safetyMargin) {
          throw createGalleryError("STORAGE_FULL");
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
            galleryViewState.status === "deleted"
              ? Boolean(asset.deletedAt)
              : !asset.deletedAt &&
                (galleryViewState.status === "all" ||
                  asset.status === galleryViewState.status);
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
      function handlePriceGalleryResultsClick(event) {
        const control = event.target.closest("[data-gallery-action]");
        const results = event.currentTarget;
        if (!control || !results.contains(control) || control.disabled) return;
        const card = control.closest(".gallery-card");
        const assetId = String(card?.dataset.assetId || "").trim();
        if (!assetId) return;
        const action = control.dataset.galleryAction;
        event.preventDefault();
        event.stopPropagation();
        if (action === "toggle-menu") {
          const details = control.closest(".gallery-more");
          if (!details) return;
          details.open = !details.open;
          handleGalleryMenuToggle(details);
          return;
        }
        closeGalleryMenus();
        const handlers = {
          zoom: () => openPriceGalleryAsset(assetId),
          copy: () => copyPriceGalleryAsset(assetId),
          download: () => downloadPriceGalleryAsset(assetId),
          edit: () => openPriceGalleryEdit(assetId),
          replace: () => openPriceGalleryReplace(assetId),
          versions: () => openPriceGalleryVersions(assetId),
          "toggle-status": () => togglePriceGalleryAssetStatus(assetId),
          recycle: () => movePriceGalleryToRecycle(assetId),
          restore: () => restorePriceGalleryFromRecycle(assetId),
          "permanent-delete": () => permanentlyDeletePriceGalleryAsset(assetId),
        };
        handlers[action]?.();
      }
      function bindPriceGalleryResultEvents() {
        const results = $("#galleryResults");
        if (!results || results.dataset.galleryEventsBound === "true") return;
        results.dataset.galleryEventsBound = "true";
        results.addEventListener("click", handlePriceGalleryResultsClick);
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
      const LEGACY_GALLERY_FULL_FIELDS = [
        "imageData",
        "imageBase64",
        "dataUrl",
        "src",
      ];
      const LEGACY_GALLERY_THUMB_FIELDS = [
        "thumbnailData",
        "thumbnailBase64",
        "thumbnailDataUrl",
        "thumbnailSrc",
      ];
      function getLegacyGalleryDataUrl(raw, fields) {
        for (const field of fields) {
          const value = raw?.[field];
          if (typeof value === "string" && /^data:image\//i.test(value)) {
            return { field, value };
          }
        }
        return null;
      }
      function decodeLegacyGalleryDataUrl(dataUrl) {
        const match = String(dataUrl || "").match(
          /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i,
        );
        if (!match || !PRICE_GALLERY_TYPES.has(match[1].toLowerCase())) {
          throw createGalleryError("UNSUPPORTED_FORMAT");
        }
        try {
          return decodeGalleryBackupBase64(
            match[2],
            match[1].toLowerCase(),
            PRICE_GALLERY_LIMITS.maxOriginalBytes,
            "旧价格图",
          );
        } catch (error) {
          throw createGalleryError("DECODE_FAILED", error);
        }
      }
      function removeLegacyGalleryBase64Fields(raw) {
        const next = { ...raw };
        [...LEGACY_GALLERY_FULL_FIELDS, ...LEGACY_GALLERY_THUMB_FIELDS].forEach(
          (field) => delete next[field],
        );
        return next;
      }
      async function runLegacyPriceGalleryMigration() {
        if (galleryLegacyMigrationStarted) return;
        galleryLegacyMigrationStarted = true;
        let parsed;
        try {
          parsed = JSON.parse(
            localStorage.getItem(PRICE_GALLERY_META_KEY) || "[]",
          );
        } catch (error) {
          console.info("价格图库迁移：元数据无法解析，未修改任何数据。");
          return;
        }
        if (!Array.isArray(parsed)) return;
        const candidates = parsed
          .map((raw, index) => ({
            raw,
            index,
            full: getLegacyGalleryDataUrl(raw, LEGACY_GALLERY_FULL_FIELDS),
            thumbnail: getLegacyGalleryDataUrl(
              raw,
              LEGACY_GALLERY_THUMB_FIELDS,
            ),
          }))
          .filter((item) => item.full || item.thumbnail);
        if (!candidates.length) {
          console.info("价格图库迁移：未检测到需要迁移的数据。");
          return;
        }
        let success = 0;
        let skipped = 0;
        let failed = 0;
        for (const candidate of candidates) {
          const assetId = String(candidate.raw?.assetId || "").trim();
          let wroteBlobs = false;
          try {
            if (!/^price_asset_[A-Za-z0-9_-]{8,128}$/.test(assetId)) {
              throw createGalleryError("MIGRATION_FAILED");
            }
            const [existingImage, existingThumbnail] = await Promise.all([
              getPriceGalleryBlobRecord(PRICE_GALLERY_IMAGE_STORE, assetId),
              getPriceGalleryBlobRecord(
                PRICE_GALLERY_THUMBNAIL_STORE,
                assetId,
              ),
            ]);
            let metadata = sanitizeGalleryMeta(candidate.raw, candidate.index);
            if (
              existingImage?.blob instanceof Blob &&
              existingThumbnail?.blob instanceof Blob
            ) {
              parsed[candidate.index] = removeLegacyGalleryBase64Fields({
                ...candidate.raw,
                ...metadata,
              });
              localStorage.setItem(
                PRICE_GALLERY_META_KEY,
                JSON.stringify(parsed),
              );
              skipped += 1;
              continue;
            }
            if (existingImage || existingThumbnail || !candidate.full) {
              throw createGalleryError("MIGRATION_FAILED");
            }
            const sourceBlob = decodeLegacyGalleryDataUrl(candidate.full.value);
            let decoded;
            try {
              decoded = await decodeGalleryImage(sourceBlob);
            } catch (error) {
              throw createGalleryError("DECODE_FAILED", error);
            } finally {
              decoded?.close?.();
            }
            const legacyFile = new File(
              [sourceBlob],
              metadata.originalName || `${metadata.name || "旧价格图"}.png`,
              { type: sourceBlob.type },
            );
            const processed = await processPriceGalleryFile(legacyFile);
            await putPriceGalleryBlobs(assetId, processed.full, processed.thumbnail);
            wroteBlobs = true;
            await verifyPriceGalleryBlobs(assetId);
            const now = new Date().toISOString();
            metadata = {
              ...metadata,
              createdAt: metadata.createdAt || now,
              updatedAt: metadata.updatedAt || now,
              originalName: legacyFile.name,
              originalType: legacyFile.type,
              originalSize: legacyFile.size,
              processedSize: processed.full.blob.size,
              width: processed.full.width,
              height: processed.full.height,
            };
            parsed[candidate.index] = removeLegacyGalleryBase64Fields({
              ...candidate.raw,
              ...metadata,
            });
            try {
              localStorage.setItem(
                PRICE_GALLERY_META_KEY,
                JSON.stringify(parsed),
              );
            } catch (error) {
              await deletePriceGalleryBlobs(assetId);
              wroteBlobs = false;
              throw createGalleryError("META_SAVE_FAILED", error);
            }
            wroteBlobs = false;
            success += 1;
          } catch (error) {
            parsed[candidate.index] = candidate.raw;
            if (wroteBlobs) {
              await deletePriceGalleryBlobs(assetId).catch(() => {});
            }
            failed += 1;
          }
        }
        priceGalleryMeta = loadPriceGalleryMeta();
        const message = `价格图库迁移：成功${success}张，跳过${skipped}张，失败${failed}张。`;
        console.info(message);
        if (mode === "gallery") {
          renderPriceGalleryResults();
          toast(message);
        }
      }
      function refreshGalleryActionButtons() {
        const uploadButton = document.querySelector(".gallery-upload");
        if (uploadButton) {
          uploadButton.disabled =
            galleryUploadBusy || Boolean(galleryStorageBusy);
          uploadButton.textContent = galleryUploadBusy
            ? "正在处理图片…"
            : "上传价格图";
        }
        const backupButton = document.querySelector(".gallery-backup");
        if (backupButton) {
          backupButton.disabled =
            galleryUploadBusy || Boolean(galleryStorageBusy);
          backupButton.textContent =
            galleryStorageBusy === "backup" ? "正在备份…" : "备份图库";
        }
        const restoreButton = document.querySelector(".gallery-restore");
        if (restoreButton) {
          restoreButton.disabled =
            galleryUploadBusy || Boolean(galleryStorageBusy);
          restoreButton.textContent =
            galleryStorageBusy === "restore" ? "正在恢复…" : "恢复图库";
        }
      }
      function setGalleryStorageBusy(operation) {
        galleryStorageBusy = operation;
        refreshGalleryActionButtons();
      }
      function setGalleryUploadBusy(busy) {
        galleryUploadBusy = busy;
        refreshGalleryActionButtons();
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
      function ensureGalleryReplaceDialog() {
        let backdrop = $("#priceGalleryReplaceDialog");
        if (backdrop) return backdrop;
        backdrop = document.createElement("div");
        backdrop.id = "priceGalleryReplaceDialog";
        backdrop.className = "gallery-upload-backdrop gallery-replace-backdrop";
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        backdrop.innerHTML = `<section class="gallery-upload-dialog gallery-replace-dialog" role="dialog" aria-modal="true" aria-labelledby="galleryReplaceTitle"><header><div><p>价格图素材</p><h2 id="galleryReplaceTitle">替换图片</h2></div><button type="button" class="gallery-upload-close" aria-label="关闭替换图片窗口" title="关闭" onclick="closeGalleryReplaceDialog()">×</button></header><div class="gallery-replace-copy"><b id="galleryReplaceAssetName"></b><span>原图会自动保存为历史版本；名称、分类、备注、排序与创建时间保持不变。</span></div><div class="gallery-upload-preview gallery-replace-preview"><img id="galleryReplacePreview" alt="待替换价格图预览" hidden><span id="galleryReplaceStatus">选择 JPEG、PNG 或 WebP，也可在此窗口按 Command+V / Ctrl+V 粘贴微信图片。</span><button type="button" class="btn" id="selectGalleryReplacement" onclick="selectGalleryReplacementFile()">选择新图片</button><input id="priceGalleryReplaceInput" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden onchange="handleGalleryReplacementInput(event)"></div><footer><button type="button" class="btn" id="cancelGalleryReplacement" onclick="closeGalleryReplaceDialog()">取消</button><button type="button" class="btn primary" id="saveGalleryReplacement" onclick="savePriceGalleryReplacement()" disabled>确认替换</button></footer></section>`;
        backdrop.addEventListener("click", (event) => {
          if (event.target === backdrop) closeGalleryReplaceDialog();
        });
        document.body.appendChild(backdrop);
        return backdrop;
      }
      function setGalleryReplaceBusy(busy) {
        galleryUploadBusy = busy;
        refreshGalleryActionButtons();
        const selectButton = $("#selectGalleryReplacement");
        const saveButton = $("#saveGalleryReplacement");
        const cancelButton = $("#cancelGalleryReplacement");
        if (selectButton) selectButton.disabled = busy;
        if (saveButton) {
          saveButton.disabled = busy || !galleryReplaceState?.processed;
          saveButton.textContent = busy ? "正在处理…" : "确认替换";
        }
        if (cancelButton) cancelButton.disabled = busy;
      }
      function openPriceGalleryReplace(assetId) {
        closeGalleryMenus();
        if (
          mode !== "gallery" ||
          galleryUploadBusy ||
          galleryStorageBusy ||
          galleryUploadState ||
          galleryEditState ||
          galleryVersionDialogState
        ) {
          return;
        }
        const asset = priceGalleryMeta.find(
          (item) => item.assetId === assetId && !item.deletedAt,
        );
        if (!asset) {
          toast("素材记录不存在");
          return;
        }
        closeGalleryReplaceDialog(true);
        const backdrop = ensureGalleryReplaceDialog();
        galleryReplaceState = {
          assetId,
          file: null,
          processed: null,
          previewUrl: "",
          source: "",
          returnFocus: document.activeElement,
        };
        $("#galleryReplaceAssetName").textContent = asset.name;
        const preview = $("#galleryReplacePreview");
        preview.hidden = true;
        preview.removeAttribute("src");
        $("#galleryReplaceStatus").textContent =
          "选择 JPEG、PNG 或 WebP，也可在此窗口按 Command+V / Ctrl+V 粘贴微信图片。";
        backdrop.hidden = false;
        backdrop.setAttribute("aria-hidden", "false");
        document.body.classList.add("replacing-gallery-image");
        setGalleryReplaceBusy(false);
        requestAnimationFrame(() => $("#selectGalleryReplacement")?.focus());
      }
      function selectGalleryReplacementFile() {
        if (!galleryReplaceState || galleryUploadBusy) return;
        $("#priceGalleryReplaceInput")?.click();
      }
      function handleGalleryReplacementInput(event) {
        const input = event.currentTarget;
        const file = input.files?.[0];
        input.value = "";
        if (file) preparePriceGalleryReplacement(file, "file");
      }
      async function preparePriceGalleryReplacement(file, source = "file") {
        const state = galleryReplaceState;
        if (!state || galleryUploadBusy || !file) return;
        setGalleryReplaceBusy(true);
        $("#galleryReplaceStatus").textContent = "正在处理图片…";
        try {
          const processed = await processPriceGalleryFile(file);
          if (galleryReplaceState !== state) return;
          if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
          state.file = file;
          state.processed = processed;
          state.source = source;
          state.previewUrl = URL.createObjectURL(processed.thumbnail.blob);
          const preview = $("#galleryReplacePreview");
          preview.src = state.previewUrl;
          preview.hidden = false;
          $("#galleryReplaceStatus").textContent =
            `${processed.full.width} × ${processed.full.height} · WebP ${formatFileSize(processed.full.blob.size)}`;
        } catch (error) {
          if (galleryReplaceState === state) {
            $("#galleryReplaceStatus").textContent = galleryErrorMessage(error);
          }
          showGalleryError(error);
        } finally {
          if (galleryReplaceState === state) setGalleryReplaceBusy(false);
        }
      }
      function closeGalleryReplaceDialog(force = false) {
        if (galleryUploadBusy && !force) return;
        const backdrop = $("#priceGalleryReplaceDialog");
        if (!backdrop || backdrop.hidden) return;
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        document.body.classList.remove("replacing-gallery-image");
        const state = galleryReplaceState;
        galleryReplaceState = null;
        if (state?.previewUrl) URL.revokeObjectURL(state.previewUrl);
        const preview = $("#galleryReplacePreview");
        if (preview) {
          preview.hidden = true;
          preview.removeAttribute("src");
        }
        if (!force) state?.returnFocus?.focus?.();
      }
      async function savePriceGalleryReplacement() {
        const state = galleryReplaceState;
        if (
          !state?.processed ||
          !state.file ||
          galleryUploadBusy ||
          !ensurePriceGalleryMetaWritable()
        ) {
          return;
        }
        const index = priceGalleryMeta.findIndex(
          (asset) => asset.assetId === state.assetId && !asset.deletedAt,
        );
        if (index < 0) {
          toast("素材记录不存在");
          closeGalleryReplaceDialog();
          return;
        }
        const asset = priceGalleryMeta[index];
        const replacedAt = new Date().toISOString();
        const versionId = createPriceGalleryVersionId();
        let snapshot = null;
        setGalleryReplaceBusy(true);
        try {
          snapshot = await replacePriceGalleryBlobRecords(
            asset,
            state.processed,
            state.file,
            versionId,
            replacedAt,
          );
          await verifyPriceGalleryBlobs(asset.assetId);
          const [version, versionThumbnail] = await Promise.all([
            getPriceGalleryVersionRecord(
              PRICE_GALLERY_VERSION_STORE,
              versionId,
            ),
            getPriceGalleryVersionRecord(
              PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
              versionId,
            ),
          ]);
          if (
            version?.assetId !== asset.assetId ||
            versionThumbnail?.assetId !== asset.assetId ||
            !(version?.blob instanceof Blob) ||
            !(versionThumbnail?.blob instanceof Blob)
          ) {
            throw createGalleryError("IDB_WRITE_FAILED");
          }
          const nextAsset = {
            ...asset,
            updatedAt: replacedAt,
            originalName:
              state.source === "clipboard"
                ? state.file.name || "微信剪贴板图片"
                : state.file.name || "价格图",
            originalType: state.file.type,
            originalSize: state.file.size,
            processedSize: state.processed.full.blob.size,
            width: state.processed.full.width,
            height: state.processed.full.height,
          };
          try {
            persistPriceGalleryMeta(
              priceGalleryMeta.map((item, itemIndex) =>
                itemIndex === index ? nextAsset : item,
              ),
            );
          } catch (error) {
            await rollbackPriceGalleryReplacement(asset.assetId, snapshot);
            snapshot = null;
            throw error;
          }
          snapshot = null;
          closeGalleryReplaceDialog(true);
          renderPriceGalleryResults();
          toast("图片已替换，原图已保存到历史版本");
        } catch (error) {
          if (snapshot) {
            await rollbackPriceGalleryReplacement(asset.assetId, snapshot).catch(
              () => {},
            );
          }
          showGalleryError(error);
        } finally {
          setGalleryReplaceBusy(false);
        }
      }
      function ensureGalleryEditDialog() {
        let backdrop = $("#priceGalleryEditDialog");
        if (backdrop) return backdrop;
        backdrop = document.createElement("div");
        backdrop.id = "priceGalleryEditDialog";
        backdrop.className = "gallery-upload-backdrop gallery-edit-backdrop";
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        backdrop.innerHTML = `<section class="gallery-upload-dialog gallery-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="galleryEditTitle"><header><div><p>价格图素材</p><h2 id="galleryEditTitle">编辑素材信息</h2></div><button type="button" class="gallery-upload-close" aria-label="关闭编辑素材窗口" title="关闭" onclick="closeGalleryEditDialog()">×</button></header><div class="gallery-upload-content"><div class="gallery-upload-preview gallery-edit-preview"><img id="galleryEditPreview" alt="价格图缩略图" hidden><span id="galleryEditPreviewStatus">正在读取缩略图…</span></div><div class="gallery-upload-fields"><label><span>图片名称</span><input id="galleryEditName" type="text" maxlength="120" oninput="updateGalleryEditConfirm()"></label><label><span>产品分类</span><select id="galleryEditProduct" onchange="updateGalleryEditConfirm()">${GALLERY_PRODUCTS.map((product) => `<option value="${esc(product)}">${esc(product)}</option>`).join("")}</select></label><label><span>备注</span><textarea id="galleryEditNote" rows="4" maxlength="500" placeholder="可填写价格、版本或使用场景等简短备注"></textarea></label><label><span>状态</span><select id="galleryEditStatus" onchange="updateGalleryEditConfirm()"><option value="current">当前使用</option><option value="history">历史状态</option></select></label></div></div><footer><button type="button" class="btn" onclick="closeGalleryEditDialog()">取消</button><button type="button" class="btn primary" id="savePriceGalleryEdits" onclick="savePriceGalleryEdits()">保存修改</button></footer></section>`;
        backdrop.addEventListener("click", (event) => {
          if (event.target === backdrop) closeGalleryEditDialog();
        });
        document.body.appendChild(backdrop);
        return backdrop;
      }
      function isGalleryEditValid() {
        return Boolean(
          galleryEditState &&
            $("#galleryEditName")?.value.trim() &&
            GALLERY_PRODUCTS.includes($("#galleryEditProduct")?.value) &&
            ["current", "history"].includes($("#galleryEditStatus")?.value),
        );
      }
      function updateGalleryEditConfirm() {
        const button = $("#savePriceGalleryEdits");
        if (button) button.disabled = !isGalleryEditValid();
      }
      async function openPriceGalleryEdit(assetId) {
        if (
          mode !== "gallery" ||
          galleryUploadBusy ||
          galleryStorageBusy ||
          galleryUploadState ||
          galleryReplaceState ||
          galleryVersionDialogState
        ) {
          return;
        }
        const asset = priceGalleryMeta.find(
          (item) => item.assetId === assetId && !item.deletedAt,
        );
        if (!asset) {
          toast("素材记录不存在");
          return;
        }
        closeGalleryMenus();
        closeGalleryEditDialog(true);
        const backdrop = ensureGalleryEditDialog();
        const state = {
          assetId,
          previewUrl: "",
          returnFocus: document.activeElement,
        };
        galleryEditState = state;
        $("#galleryEditName").value = asset.name;
        $("#galleryEditProduct").value = asset.productCategory;
        $("#galleryEditNote").value = asset.note;
        $("#galleryEditStatus").value = asset.status;
        const preview = $("#galleryEditPreview");
        const previewStatus = $("#galleryEditPreviewStatus");
        preview.hidden = true;
        preview.removeAttribute("src");
        preview.alt = `${asset.name}缩略图`;
        previewStatus.hidden = false;
        previewStatus.textContent = "正在读取缩略图…";
        backdrop.hidden = false;
        backdrop.setAttribute("aria-hidden", "false");
        document.body.classList.add("editing-gallery-asset");
        updateGalleryEditConfirm();
        requestAnimationFrame(() => $("#galleryEditName")?.focus());
        try {
          const record = await getPriceGalleryBlobRecord(
            PRICE_GALLERY_THUMBNAIL_STORE,
            assetId,
          );
          if (galleryEditState !== state || backdrop.hidden) return;
          if (!(record?.blob instanceof Blob)) {
            previewStatus.textContent = "缩略图暂时无法读取";
            return;
          }
          state.previewUrl = URL.createObjectURL(record.blob);
          preview.src = state.previewUrl;
          preview.hidden = false;
          previewStatus.textContent = `${record.width || asset.width} × ${record.height || asset.height} · 只读预览`;
        } catch (error) {
          if (galleryEditState === state) {
            previewStatus.textContent = "缩略图暂时无法读取";
          }
        }
      }
      function closeGalleryEditDialog(force = false) {
        const backdrop = $("#priceGalleryEditDialog");
        if (!backdrop || backdrop.hidden) return;
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        document.body.classList.remove("editing-gallery-asset");
        const state = galleryEditState;
        galleryEditState = null;
        if (state?.previewUrl) URL.revokeObjectURL(state.previewUrl);
        const preview = $("#galleryEditPreview");
        if (preview) {
          preview.hidden = true;
          preview.removeAttribute("src");
        }
        if (!force) state?.returnFocus?.focus?.();
      }
      function savePriceGalleryEdits() {
        if (!isGalleryEditValid() || !ensurePriceGalleryMetaWritable()) return;
        const assetId = galleryEditState.assetId;
        const index = priceGalleryMeta.findIndex(
          (asset) => asset.assetId === assetId,
        );
        if (index < 0) {
          closeGalleryEditDialog();
          toast("素材记录不存在");
          return;
        }
        const nextAsset = {
          ...priceGalleryMeta[index],
          name: $("#galleryEditName").value.trim(),
          productCategory: $("#galleryEditProduct").value,
          note: $("#galleryEditNote").value.trim(),
          status: $("#galleryEditStatus").value,
          updatedAt: new Date().toISOString(),
        };
        const nextMeta = priceGalleryMeta.map((asset, assetIndex) =>
          assetIndex === index ? nextAsset : asset,
        );
        try {
          persistPriceGalleryMeta(nextMeta);
        } catch (error) {
          showGalleryError(error);
          return;
        }
        closeGalleryEditDialog();
        renderPriceGalleryResults();
        toast("素材信息已更新");
      }
      function togglePriceGalleryAssetStatus(assetId) {
        closeGalleryMenus();
        if (
          galleryUploadBusy ||
          galleryStorageBusy ||
          galleryEditState ||
          galleryReplaceState ||
          galleryVersionDialogState
        ) {
          return;
        }
        if (!ensurePriceGalleryMetaWritable()) return;
        const index = priceGalleryMeta.findIndex(
          (asset) => asset.assetId === assetId,
        );
        if (index < 0) {
          toast("素材记录不存在");
          return;
        }
        const asset = priceGalleryMeta[index];
        const nextStatus = asset.status === "history" ? "current" : "history";
        const action =
          nextStatus === "history" ? "移入历史" : "恢复为当前使用";
        if (!confirm(`确认将“${asset.name}”${action}吗？`)) return;
        const nextMeta = priceGalleryMeta.map((item, assetIndex) =>
          assetIndex === index
            ? {
                ...item,
                status: nextStatus,
                updatedAt: new Date().toISOString(),
              }
            : item,
        );
        try {
          persistPriceGalleryMeta(nextMeta);
        } catch (error) {
          showGalleryError(error);
          return;
        }
        renderPriceGalleryResults();
        toast(
          nextStatus === "history" ? "已移入历史" : "已恢复为当前使用",
        );
      }
      function movePriceGalleryToRecycle(assetId) {
        closeGalleryMenus();
        if (
          galleryUploadBusy ||
          galleryStorageBusy ||
          galleryEditState ||
          galleryReplaceState ||
          !ensurePriceGalleryMetaWritable()
        ) {
          return;
        }
        const asset = priceGalleryMeta.find(
          (item) => item.assetId === assetId && !item.deletedAt,
        );
        if (!asset) return;
        if (!confirm(`确认删除“${asset.name}”并移入回收站吗？`)) return;
        if (!confirm("删除后默认不再显示，但可在“已删除”筛选中恢复。请再次确认。")) {
          return;
        }
        const now = new Date().toISOString();
        try {
          persistPriceGalleryMeta(
            priceGalleryMeta.map((item) =>
              item.assetId === assetId
                ? { ...item, deletedAt: now, updatedAt: now }
                : item,
            ),
          );
          renderPriceGalleryResults();
          toast("素材已移入回收站");
        } catch (error) {
          showGalleryError(error);
        }
      }
      function restorePriceGalleryFromRecycle(assetId) {
        closeGalleryMenus();
        if (galleryStorageBusy || !ensurePriceGalleryMetaWritable()) return;
        const asset = priceGalleryMeta.find(
          (item) => item.assetId === assetId && item.deletedAt,
        );
        if (!asset) return;
        if (!confirm(`确认恢复“${asset.name}”吗？`)) return;
        const now = new Date().toISOString();
        try {
          persistPriceGalleryMeta(
            priceGalleryMeta.map((item) =>
              item.assetId === assetId
                ? { ...item, deletedAt: "", updatedAt: now }
                : item,
            ),
          );
          renderPriceGalleryResults();
          toast("素材已恢复");
        } catch (error) {
          showGalleryError(error);
        }
      }
      async function capturePriceGalleryAssetRecords(assetId) {
        const [image, thumbnail, versions] = await Promise.all([
          getPriceGalleryBlobRecord(PRICE_GALLERY_IMAGE_STORE, assetId),
          getPriceGalleryBlobRecord(PRICE_GALLERY_THUMBNAIL_STORE, assetId),
          getPriceGalleryVersions(assetId),
        ]);
        if (!(image?.blob instanceof Blob) || !(thumbnail?.blob instanceof Blob)) {
          throw createGalleryError("IMAGE_NOT_FOUND");
        }
        return { image, thumbnail, versions };
      }
      async function deletePriceGalleryAssetRecords(assetId, snapshot) {
        const db = await openPriceGalleryDb();
        const transaction = db.transaction(
          [
            PRICE_GALLERY_IMAGE_STORE,
            PRICE_GALLERY_THUMBNAIL_STORE,
            PRICE_GALLERY_VERSION_STORE,
            PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
          ],
          "readwrite",
        );
        transaction.objectStore(PRICE_GALLERY_IMAGE_STORE).delete(assetId);
        transaction
          .objectStore(PRICE_GALLERY_THUMBNAIL_STORE)
          .delete(assetId);
        snapshot.versions.forEach(({ image, thumbnail }) => {
          const versionId = image?.versionId || thumbnail?.versionId;
          if (!versionId) return;
          transaction
            .objectStore(PRICE_GALLERY_VERSION_STORE)
            .delete(versionId);
          transaction
            .objectStore(PRICE_GALLERY_VERSION_THUMBNAIL_STORE)
            .delete(versionId);
        });
        await waitForGalleryTransaction(transaction);
      }
      async function restorePriceGalleryAssetRecords(snapshot) {
        const db = await openPriceGalleryDb();
        const transaction = db.transaction(
          [
            PRICE_GALLERY_IMAGE_STORE,
            PRICE_GALLERY_THUMBNAIL_STORE,
            PRICE_GALLERY_VERSION_STORE,
            PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
          ],
          "readwrite",
        );
        transaction
          .objectStore(PRICE_GALLERY_IMAGE_STORE)
          .put(snapshot.image);
        transaction
          .objectStore(PRICE_GALLERY_THUMBNAIL_STORE)
          .put(snapshot.thumbnail);
        snapshot.versions.forEach(({ image, thumbnail }) => {
          if (image) {
            transaction.objectStore(PRICE_GALLERY_VERSION_STORE).put(image);
          }
          if (thumbnail) {
            transaction
              .objectStore(PRICE_GALLERY_VERSION_THUMBNAIL_STORE)
              .put(thumbnail);
          }
        });
        await waitForGalleryTransaction(transaction);
      }
      async function permanentlyDeletePriceGalleryAsset(assetId) {
        closeGalleryMenus();
        if (galleryStorageBusy || !ensurePriceGalleryMetaWritable()) return;
        const asset = priceGalleryMeta.find(
          (item) => item.assetId === assetId && item.deletedAt,
        );
        if (!asset) return;
        const warning =
          "永久删除后将无法恢复，原图、缩略图和历史版本都会被删除。";
        if (!confirm(warning)) return;
        if (!confirm(`请再次确认永久删除“${asset.name}”。此操作不可撤销。`)) {
          return;
        }
        setGalleryStorageBusy("permanent-delete");
        let snapshot = null;
        try {
          snapshot = await capturePriceGalleryAssetRecords(assetId);
          await deletePriceGalleryAssetRecords(assetId, snapshot);
          const [remainingImage, remainingThumbnail, remainingVersions] =
            await Promise.all([
              getPriceGalleryBlobRecord(
                PRICE_GALLERY_IMAGE_STORE,
                assetId,
              ),
              getPriceGalleryBlobRecord(
                PRICE_GALLERY_THUMBNAIL_STORE,
                assetId,
              ),
              getPriceGalleryVersions(assetId),
            ]);
          if (
            remainingImage ||
            remainingThumbnail ||
            remainingVersions.length
          ) {
            throw createGalleryError("IDB_TRANSACTION_FAILED");
          }
          try {
            persistPriceGalleryMeta(
              priceGalleryMeta.filter((item) => item.assetId !== assetId),
            );
          } catch (error) {
            await restorePriceGalleryAssetRecords(snapshot);
            snapshot = null;
            throw error;
          }
          snapshot = null;
          renderPriceGalleryResults();
          toast("素材已永久删除");
        } catch (error) {
          if (snapshot) {
            await restorePriceGalleryAssetRecords(snapshot).catch(() => {});
          }
          showGalleryError(error);
        } finally {
          setGalleryStorageBusy("");
        }
      }
      function formatFileSize(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
        return `${(value / (1024 * 1024)).toFixed(2)} MB`;
      }
      async function startPriceGalleryUpload(file, source = "file") {
        if (
          galleryUploadBusy ||
          galleryStorageBusy ||
          galleryEditState ||
          galleryReplaceState ||
          galleryVersionDialogState ||
          !file
        ) {
          return;
        }
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
        if (galleryUploadBusy || galleryStorageBusy || galleryEditState) return;
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
        if (
          !state ||
          galleryUploadBusy ||
          galleryStorageBusy ||
          !isGalleryUploadValid() ||
          !ensurePriceGalleryMetaWritable()
        ) {
          return;
        }
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
          galleryStorageBusy ||
          galleryUploadState ||
          galleryEditState ||
          galleryVersionDialogState
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
        if (galleryReplaceState) {
          preparePriceGalleryReplacement(files[0], "clipboard");
        } else {
          startPriceGalleryUpload(files[0], "clipboard");
        }
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
      function ensureGalleryVersionDialog() {
        let backdrop = $("#priceGalleryVersionDialog");
        if (backdrop) return backdrop;
        backdrop = document.createElement("div");
        backdrop.id = "priceGalleryVersionDialog";
        backdrop.className = "gallery-upload-backdrop gallery-version-backdrop";
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        backdrop.innerHTML = `<section class="gallery-upload-dialog gallery-version-dialog" role="dialog" aria-modal="true" aria-labelledby="galleryVersionTitle"><header><div><p>价格图素材</p><h2 id="galleryVersionTitle">历史版本</h2></div><button type="button" class="gallery-upload-close" aria-label="关闭历史版本窗口" title="关闭" onclick="closeGalleryVersionDialog()">×</button></header><div class="gallery-version-summary" id="galleryVersionSummary"></div><div class="gallery-version-list" id="galleryVersionList"></div><footer><button type="button" class="btn" onclick="closeGalleryVersionDialog()">关闭</button></footer></section>`;
        backdrop.addEventListener("click", (event) => {
          if (event.target === backdrop) closeGalleryVersionDialog();
        });
        document.body.appendChild(backdrop);
        return backdrop;
      }
      function clearGalleryVersionUrls(state = galleryVersionDialogState) {
        state?.urls?.forEach((url) => URL.revokeObjectURL(url));
        if (state?.urls) state.urls = [];
      }
      async function openPriceGalleryVersions(assetId) {
        closeGalleryMenus();
        if (
          mode !== "gallery" ||
          galleryUploadBusy ||
          galleryStorageBusy ||
          galleryUploadState ||
          galleryEditState ||
          galleryReplaceState
        ) {
          return;
        }
        const asset = priceGalleryMeta.find((item) => item.assetId === assetId);
        if (!asset) {
          toast("素材记录不存在");
          return;
        }
        closeGalleryVersionDialog(true);
        const backdrop = ensureGalleryVersionDialog();
        const state = {
          assetId,
          urls: [],
          returnFocus: document.activeElement,
        };
        galleryVersionDialogState = state;
        $("#galleryVersionTitle").textContent = `${asset.name} · 历史版本`;
        $("#galleryVersionSummary").textContent = "正在读取版本记录…";
        $("#galleryVersionList").innerHTML = "";
        backdrop.hidden = false;
        backdrop.setAttribute("aria-hidden", "false");
        document.body.classList.add("viewing-gallery-versions");
        try {
          const [currentImage, currentThumbnail, history] = await Promise.all([
            getPriceGalleryBlobRecord(PRICE_GALLERY_IMAGE_STORE, assetId),
            getPriceGalleryBlobRecord(PRICE_GALLERY_THUMBNAIL_STORE, assetId),
            getPriceGalleryVersions(assetId),
          ]);
          if (galleryVersionDialogState !== state) return;
          if (
            !(currentImage?.blob instanceof Blob) ||
            !(currentThumbnail?.blob instanceof Blob)
          ) {
            throw createGalleryError("IMAGE_NOT_FOUND");
          }
          if (
            history.some(
              ({ image, thumbnail }) =>
                !(image?.blob instanceof Blob) ||
                !(thumbnail?.blob instanceof Blob) ||
                image.versionId !== thumbnail.versionId,
            )
          ) {
            throw createGalleryError("IMAGE_NOT_FOUND");
          }
          const currentUrl = URL.createObjectURL(currentThumbnail.blob);
          state.urls.push(currentUrl);
          const rows = [
            {
              versionId: "current",
              image: currentImage,
              thumbnail: currentThumbnail,
              createdAt: asset.updatedAt || asset.createdAt,
              current: true,
            },
            ...history.map(({ image, thumbnail }) => ({
              versionId: image.versionId,
              image,
              thumbnail,
              createdAt: image.createdAt,
              current: false,
            })),
          ];
          $("#galleryVersionSummary").textContent =
            `当前版本 1 个，历史版本 ${history.length} 个；历史版本按时间从新到旧排列。`;
          $("#galleryVersionList").innerHTML = rows
            .map((row, index) => {
              let thumbnailUrl = "";
              if (index === 0) {
                thumbnailUrl = currentUrl;
              } else if (row.thumbnail?.blob instanceof Blob) {
                thumbnailUrl = URL.createObjectURL(row.thumbnail.blob);
                state.urls.push(thumbnailUrl);
              }
              const idArg = JSON.stringify(row.versionId);
              const unavailable = thumbnailUrl
                ? `<button type="button" class="gallery-version-thumb" onclick='openPriceGalleryVersion(${JSON.stringify(assetId)},${idArg})'><img src="${esc(thumbnailUrl)}" alt="${esc(asset.name)}版本预览"></button>`
                : '<div class="gallery-version-thumb gallery-version-missing">缩略图缺失</div>';
              return `<article class="gallery-version-item ${row.current ? "is-current" : ""}">${unavailable}<div class="gallery-version-info"><div><b>${row.current ? "当前版本" : "历史版本"}</b>${row.current ? '<span class="gallery-version-current">当前</span>' : ""}</div><dl><div><dt>版本时间</dt><dd>${esc(formatGalleryDate(row.createdAt))}</dd></div><div><dt>图片尺寸</dt><dd>${row.image.width || 0} × ${row.image.height || 0}</dd></div><div><dt>WebP 大小</dt><dd>${esc(formatFileSize(row.image.size))}</dd></div></dl><div class="gallery-version-actions"><button type="button" class="btn" onclick='openPriceGalleryVersion(${JSON.stringify(assetId)},${idArg})'>放大</button><button type="button" class="btn" onclick='downloadPriceGalleryVersion(${JSON.stringify(assetId)},${idArg})'>下载</button>${row.current ? "" : `<button type="button" class="btn primary" onclick='restorePriceGalleryVersion(${JSON.stringify(assetId)},${idArg})'>恢复此版本</button>`}</div></div></article>`;
            })
            .join("");
        } catch (error) {
          if (galleryVersionDialogState === state) {
            $("#galleryVersionSummary").textContent = galleryErrorMessage(error);
          }
          showGalleryError(error);
        }
      }
      function closeGalleryVersionDialog(force = false) {
        const backdrop = $("#priceGalleryVersionDialog");
        if (!backdrop || backdrop.hidden) return;
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
        document.body.classList.remove("viewing-gallery-versions");
        const state = galleryVersionDialogState;
        galleryVersionDialogState = null;
        clearGalleryVersionUrls(state);
        $("#galleryVersionList").innerHTML = "";
        if (!force) state?.returnFocus?.focus?.();
      }
      async function getGalleryVersionImageRecord(assetId, versionId) {
        if (versionId === "current") {
          return getPriceGalleryBlobRecord(PRICE_GALLERY_IMAGE_STORE, assetId);
        }
        const record = await getPriceGalleryVersionRecord(
          PRICE_GALLERY_VERSION_STORE,
          versionId,
        );
        return record?.assetId === assetId ? record : null;
      }
      async function openPriceGalleryVersion(assetId, versionId) {
        closeImageViewer();
        try {
          const record = await getGalleryVersionImageRecord(assetId, versionId);
          if (!(record?.blob instanceof Blob)) {
            throw createGalleryError("IMAGE_NOT_FOUND");
          }
          const asset = priceGalleryMeta.find((item) => item.assetId === assetId);
          galleryViewerUrl = URL.createObjectURL(record.blob);
          const viewer = document.createElement("div");
          viewer.className = "image-viewer";
          viewer.setAttribute("role", "dialog");
          viewer.setAttribute("aria-modal", "true");
          viewer.setAttribute("aria-label", `${asset?.name || "价格图"}版本大图`);
          viewer.innerHTML = `<button type="button" class="image-viewer-close" onclick="closeImageViewer()" aria-label="关闭图片">×</button><div class="image-viewer-content"><img src="${esc(galleryViewerUrl)}" alt="${esc(asset?.name || "价格图")}"><div>${versionId === "current" ? "当前版本" : `历史版本 · ${esc(formatGalleryDate(record.createdAt))}`}</div></div>`;
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
      async function downloadPriceGalleryVersion(assetId, versionId) {
        try {
          const record = await getGalleryVersionImageRecord(assetId, versionId);
          if (!(record?.blob instanceof Blob)) {
            throw createGalleryError("IMAGE_NOT_FOUND");
          }
          const asset = priceGalleryMeta.find((item) => item.assetId === assetId);
          const suffix =
            versionId === "current"
              ? "当前版本"
              : formatGalleryDate(record.createdAt).replace(/[/:\s]/g, "-");
          const url = URL.createObjectURL(record.blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = safeGalleryDownloadName(
            `${asset?.name || "价格图"}_${suffix}`,
          );
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          toast("版本图片已下载");
        } catch (error) {
          showGalleryError(error);
        }
      }
      async function restorePriceGalleryVersionBlobRecords(
        asset,
        selectedImage,
        selectedThumbnail,
        restoredAt,
      ) {
        const [oldImage, oldThumbnail] = await Promise.all([
          getPriceGalleryBlobRecord(PRICE_GALLERY_IMAGE_STORE, asset.assetId),
          getPriceGalleryBlobRecord(
            PRICE_GALLERY_THUMBNAIL_STORE,
            asset.assetId,
          ),
        ]);
        if (
          !(oldImage?.blob instanceof Blob) ||
          !(oldThumbnail?.blob instanceof Blob)
        ) {
          throw createGalleryError("IMAGE_NOT_FOUND");
        }
        const currentVersionId = createPriceGalleryVersionId();
        const currentVersionImage = makeGalleryVersionRecord(
          oldImage,
          currentVersionId,
          asset.assetId,
          restoredAt,
          asset,
        );
        const currentVersionThumbnail = makeGalleryVersionRecord(
          oldThumbnail,
          currentVersionId,
          asset.assetId,
          restoredAt,
          asset,
        );
        const restoredImage = {
          assetId: asset.assetId,
          blob: selectedImage.blob,
          width: selectedImage.width,
          height: selectedImage.height,
          size: selectedImage.size,
          mimeType: selectedImage.mimeType,
        };
        const restoredThumbnail = {
          assetId: asset.assetId,
          blob: selectedThumbnail.blob,
          width: selectedThumbnail.width,
          height: selectedThumbnail.height,
          size: selectedThumbnail.size,
          mimeType: selectedThumbnail.mimeType,
        };
        const db = await openPriceGalleryDb();
        const transaction = db.transaction(
          [
            PRICE_GALLERY_IMAGE_STORE,
            PRICE_GALLERY_THUMBNAIL_STORE,
            PRICE_GALLERY_VERSION_STORE,
            PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
          ],
          "readwrite",
        );
        transaction
          .objectStore(PRICE_GALLERY_VERSION_STORE)
          .add(currentVersionImage);
        transaction
          .objectStore(PRICE_GALLERY_VERSION_THUMBNAIL_STORE)
          .add(currentVersionThumbnail);
        transaction.objectStore(PRICE_GALLERY_IMAGE_STORE).put(restoredImage);
        transaction
          .objectStore(PRICE_GALLERY_THUMBNAIL_STORE)
          .put(restoredThumbnail);
        await waitForGalleryTransaction(transaction);
        return {
          oldImage,
          oldThumbnail,
          oldVersionImage: currentVersionImage,
          oldVersionThumbnail: currentVersionThumbnail,
        };
      }
      async function restorePriceGalleryVersion(assetId, versionId) {
        const asset = priceGalleryMeta.find(
          (item) => item.assetId === assetId && !item.deletedAt,
        );
        if (!asset || versionId === "current" || galleryStorageBusy) return;
        if (!confirm(`确认将“${asset.name}”恢复到所选历史版本吗？`)) return;
        if (!confirm("恢复后，当前版本会自动保存到历史版本。请再次确认。")) {
          return;
        }
        setGalleryStorageBusy("version-restore");
        let snapshot = null;
        try {
          const [selectedImage, selectedThumbnail] = await Promise.all([
            getPriceGalleryVersionRecord(PRICE_GALLERY_VERSION_STORE, versionId),
            getPriceGalleryVersionRecord(
              PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
              versionId,
            ),
          ]);
          if (
            selectedImage?.assetId !== assetId ||
            selectedThumbnail?.assetId !== assetId ||
            !(selectedImage.blob instanceof Blob) ||
            !(selectedThumbnail.blob instanceof Blob)
          ) {
            throw createGalleryError("IMAGE_NOT_FOUND");
          }
          const restoredAt = new Date().toISOString();
          snapshot = await restorePriceGalleryVersionBlobRecords(
            asset,
            selectedImage,
            selectedThumbnail,
            restoredAt,
          );
          await verifyPriceGalleryBlobs(assetId);
          const [savedCurrentVersion, savedCurrentThumbnail] =
            await Promise.all([
              getPriceGalleryVersionRecord(
                PRICE_GALLERY_VERSION_STORE,
                snapshot.oldVersionImage.versionId,
              ),
              getPriceGalleryVersionRecord(
                PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
                snapshot.oldVersionThumbnail.versionId,
              ),
            ]);
          if (
            savedCurrentVersion?.assetId !== assetId ||
            savedCurrentThumbnail?.assetId !== assetId ||
            !(savedCurrentVersion.blob instanceof Blob) ||
            !(savedCurrentThumbnail.blob instanceof Blob)
          ) {
            throw createGalleryError("IDB_WRITE_FAILED");
          }
          const nextAsset = {
            ...asset,
            updatedAt: restoredAt,
            originalName: selectedImage.originalName || asset.originalName,
            originalType: selectedImage.originalType || asset.originalType,
            originalSize: selectedImage.originalSize || asset.originalSize,
            processedSize: selectedImage.size,
            width: selectedImage.width,
            height: selectedImage.height,
          };
          try {
            persistPriceGalleryMeta(
              priceGalleryMeta.map((item) =>
                item.assetId === assetId ? nextAsset : item,
              ),
            );
          } catch (error) {
            await rollbackPriceGalleryReplacement(assetId, snapshot);
            snapshot = null;
            throw error;
          }
          snapshot = null;
          closeGalleryVersionDialog(true);
          renderPriceGalleryResults();
          toast("历史版本已恢复，原当前版本已保存");
        } catch (error) {
          if (snapshot) {
            await rollbackPriceGalleryReplacement(assetId, snapshot).catch(
              () => {},
            );
          }
          showGalleryError(error);
        } finally {
          setGalleryStorageBusy("");
        }
      }
      function createGalleryBackupError(message, cause = null) {
        const error = new Error(message);
        error.galleryBackupMessage = message;
        error.cause = cause;
        return error;
      }
      function galleryBackupErrorMessage(error) {
        if (error?.galleryBackupMessage) return error.galleryBackupMessage;
        if (error?.galleryCode) return galleryErrorMessage(error);
        if (galleryErrorCode(error) === "STORAGE_FULL") {
          return galleryErrorMessage(createGalleryError("STORAGE_FULL"));
        }
        if (galleryErrorCode(error) === "IDB_UNAVAILABLE") {
          return galleryErrorMessage(createGalleryError("IDB_UNAVAILABLE"));
        }
        return "价格图库备份操作失败，请稍后重试。";
      }
      function galleryBlobToBase64(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result || "");
            const separator = result.indexOf(",");
            if (separator < 0) {
              reject(createGalleryBackupError("图片备份编码失败。"));
              return;
            }
            resolve(result.slice(separator + 1));
          };
          reader.onerror = () =>
            reject(
              createGalleryBackupError("图片备份读取失败。", reader.error),
            );
          reader.onabort = () =>
            reject(createGalleryBackupError("图片备份读取已取消。"));
          reader.readAsDataURL(blob);
        });
      }
      function decodeGalleryBackupBase64(value, mimeType, maxBytes, label) {
        if (typeof value !== "string" || !value) {
          throw createGalleryBackupError(`${label}缺少可恢复图片数据。`);
        }
        const encoded = value.replace(/\s/g, "");
        const maxEncodedLength = Math.ceil(maxBytes / 3) * 4 + 4;
        if (
          encoded.length > maxEncodedLength ||
          encoded.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
        ) {
          throw createGalleryBackupError(`${label}的Base64数据无效。`);
        }
        let binary;
        try {
          binary = atob(encoded);
        } catch (error) {
          throw createGalleryBackupError(`${label}的Base64数据无法解码。`, error);
        }
        if (!binary.length || binary.length > maxBytes) {
          throw createGalleryBackupError(`${label}的图片体积超出允许范围。`);
        }
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return new Blob([bytes], { type: mimeType });
      }
      function isGalleryWebpBlob(blob) {
        return blob
          .slice(0, 12)
          .arrayBuffer()
          .then((buffer) => {
            const bytes = new Uint8Array(buffer);
            if (bytes.length < 12) return false;
            return (
              String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
              String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
            );
          });
      }
      function validGalleryBackupDate(value) {
        return (
          typeof value === "string" &&
          (!value || Number.isFinite(new Date(value).getTime()))
        );
      }
      function validateGalleryBackupMetadata(raw, index) {
        const label = `第${index + 1}条素材`;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw createGalleryBackupError(`${label}缺少有效元数据。`);
        }
        const assetId = String(raw.assetId || "").trim();
        if (!/^price_asset_[A-Za-z0-9_-]{8,128}$/.test(assetId)) {
          throw createGalleryBackupError(`${label}的assetId无效。`);
        }
        if (
          typeof raw.name !== "string" ||
          !raw.name.trim() ||
          raw.name.trim().length > 120
        ) {
          throw createGalleryBackupError(`${label}的图片名称无效。`);
        }
        if (!GALLERY_PRODUCTS.includes(raw.productCategory)) {
          throw createGalleryBackupError(`${label}的产品分类无效。`);
        }
        if (typeof raw.note !== "string" || raw.note.length > 500) {
          throw createGalleryBackupError(`${label}的备注无效。`);
        }
        if (!["current", "history"].includes(raw.status)) {
          throw createGalleryBackupError(`${label}的状态无效。`);
        }
        if (!Number.isFinite(raw.customOrder) || raw.customOrder < 0) {
          throw createGalleryBackupError(`${label}的排序值无效。`);
        }
        if (
          !validGalleryBackupDate(raw.createdAt) ||
          !validGalleryBackupDate(raw.updatedAt) ||
          !validGalleryBackupDate(raw.deletedAt || "")
        ) {
          throw createGalleryBackupError(`${label}的时间字段无效。`);
        }
        if (
          typeof raw.originalName !== "string" ||
          raw.originalName.length > 255 ||
          !PRICE_GALLERY_TYPES.has(raw.originalType)
        ) {
          throw createGalleryBackupError(`${label}的原文件信息无效。`);
        }
        const numericFields = [
          ["originalSize", PRICE_GALLERY_LIMITS.maxOriginalBytes],
          ["processedSize", PRICE_GALLERY_LIMITS.maxProcessedBytes],
          ["width", PRICE_GALLERY_LIMITS.maxFullSide],
          ["height", PRICE_GALLERY_LIMITS.maxFullSide],
        ];
        for (const [field, maximum] of numericFields) {
          if (
            !Number.isInteger(raw[field]) ||
            raw[field] <= 0 ||
            raw[field] > maximum
          ) {
            throw createGalleryBackupError(`${label}的${field}字段无效。`);
          }
        }
        return {
          assetId,
          name: raw.name.trim(),
          productCategory: raw.productCategory,
          note: raw.note,
          status: raw.status,
          customOrder: raw.customOrder,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
          originalName: raw.originalName,
          originalType: raw.originalType,
          originalSize: raw.originalSize,
          processedSize: raw.processedSize,
          width: raw.width,
          height: raw.height,
          deletedAt: raw.deletedAt || "",
        };
      }
      async function validateGalleryBackupImage(
        raw,
        assetId,
        label,
        maxBytes,
        maxSide,
        versionId = "",
      ) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw createGalleryBackupError(`${label}记录不存在。`);
        }
        if (raw.assetId !== assetId) {
          throw createGalleryBackupError(`${label}的assetId不一致。`);
        }
        if (versionId && raw.versionId !== versionId) {
          throw createGalleryBackupError(`${label}的versionId不一致。`);
        }
        if (raw.mimeType !== "image/webp") {
          throw createGalleryBackupError(`${label}的MIME类型不受支持。`);
        }
        if (
          !Number.isInteger(raw.width) ||
          !Number.isInteger(raw.height) ||
          raw.width <= 0 ||
          raw.height <= 0 ||
          raw.width > maxSide ||
          raw.height > maxSide
        ) {
          throw createGalleryBackupError(`${label}的图片尺寸无效。`);
        }
        if (
          !Number.isInteger(raw.size) ||
          raw.size <= 0 ||
          raw.size > maxBytes
        ) {
          throw createGalleryBackupError(`${label}的图片大小无效。`);
        }
        const blob = decodeGalleryBackupBase64(
          raw.data,
          raw.mimeType,
          maxBytes,
          label,
        );
        if (blob.size !== raw.size) {
          throw createGalleryBackupError(`${label}声明大小与实际数据不一致。`);
        }
        if (!(await isGalleryWebpBlob(blob))) {
          throw createGalleryBackupError(`${label}不是有效的WebP图片。`);
        }
        let decoded;
        try {
          decoded = await decodeGalleryImage(blob);
          if (decoded.width !== raw.width || decoded.height !== raw.height) {
            throw createGalleryBackupError(`${label}声明尺寸与实际图片不一致。`);
          }
        } catch (error) {
          if (error?.galleryBackupMessage) throw error;
          throw createGalleryBackupError(`${label}无法解码。`, error);
        } finally {
          decoded?.close?.();
        }
        return {
          assetId,
          ...(versionId ? { versionId } : {}),
          blob,
          width: raw.width,
          height: raw.height,
          size: raw.size,
          mimeType: raw.mimeType,
          ...(versionId
            ? {
                createdAt: String(raw.createdAt || ""),
                originalName: String(raw.originalName || ""),
                originalType: String(raw.originalType || ""),
                originalSize: Number(raw.originalSize) || 0,
              }
            : {}),
        };
      }
      async function validatePriceGalleryBackup(rawBackup) {
        if (Array.isArray(rawBackup)) {
          throw createGalleryBackupError(
            '这是普通知识库备份，请使用左下角“导入”按钮。',
          );
        }
        if (!rawBackup || typeof rawBackup !== "object") {
          throw createGalleryBackupError("备份文件结构无效。");
        }
        if (rawBackup.backupType !== PRICE_GALLERY_BACKUP_TYPE) {
          throw createGalleryBackupError("backupType不正确，不是价格图库备份。");
        }
        if (
          !PRICE_GALLERY_BACKUP_SUPPORTED_VERSIONS.has(
            rawBackup.schemaVersion,
          )
        ) {
          throw createGalleryBackupError(
            `不支持的价格图库备份版本：${String(rawBackup.schemaVersion ?? "未知")}。`,
          );
        }
        if (
          !validGalleryBackupDate(rawBackup.exportedAt) ||
          !rawBackup.exportedAt
        ) {
          throw createGalleryBackupError("备份导出时间无效。");
        }
        if (!Array.isArray(rawBackup.assets)) {
          throw createGalleryBackupError("备份素材列表格式无效。");
        }
        if (
          !Number.isInteger(rawBackup.assetCount) ||
          rawBackup.assetCount !== rawBackup.assets.length
        ) {
          throw createGalleryBackupError("备份声明的素材数量不一致。");
        }
        const seen = new Set();
        const seenVersions = new Set();
        const validated = [];
        const failures = [];
        for (let index = 0; index < rawBackup.assets.length; index += 1) {
          const rawAsset = rawBackup.assets[index];
          try {
            const metadata = validateGalleryBackupMetadata(
              rawAsset?.metadata,
              index,
            );
            if (seen.has(metadata.assetId)) {
              throw createGalleryBackupError(
                `备份内存在重复assetId：${metadata.assetId}。`,
              );
            }
            seen.add(metadata.assetId);
            const image = await validateGalleryBackupImage(
              rawAsset?.image,
              metadata.assetId,
              `素材“${metadata.name}”的原图`,
              PRICE_GALLERY_LIMITS.maxProcessedBytes,
              PRICE_GALLERY_LIMITS.maxFullSide,
            );
            const thumbnail = await validateGalleryBackupImage(
              rawAsset?.thumbnail,
              metadata.assetId,
              `素材“${metadata.name}”的缩略图`,
              PRICE_GALLERY_LIMITS.maxThumbnailBytes,
              PRICE_GALLERY_LIMITS.maxThumbnailSide,
            );
            if (
              metadata.processedSize !== image.size ||
              metadata.width !== image.width ||
              metadata.height !== image.height
            ) {
              throw createGalleryBackupError(
                `素材“${metadata.name}”的元数据与原图不一致。`,
              );
            }
            const rawVersions =
              rawBackup.schemaVersion >= 2 ? rawAsset?.versions : [];
            if (!Array.isArray(rawVersions)) {
              throw createGalleryBackupError(
                `素材“${metadata.name}”的历史版本列表无效。`,
              );
            }
            const versions = [];
            for (
              let versionIndex = 0;
              versionIndex < rawVersions.length;
              versionIndex += 1
            ) {
              const rawVersion = rawVersions[versionIndex];
              const versionId = String(rawVersion?.versionId || "").trim();
              if (
                !/^price_version_[A-Za-z0-9_-]{8,128}$/.test(versionId)
              ) {
                throw createGalleryBackupError(
                  `素材“${metadata.name}”的第${versionIndex + 1}个versionId无效。`,
                );
              }
              if (seenVersions.has(versionId)) {
                throw createGalleryBackupError(
                  `备份内存在重复versionId：${versionId}。`,
                );
              }
              if (
                !validGalleryBackupDate(rawVersion.createdAt) ||
                !rawVersion.createdAt
              ) {
                throw createGalleryBackupError(
                  `素材“${metadata.name}”的历史版本时间无效。`,
                );
              }
              seenVersions.add(versionId);
              const versionImage = await validateGalleryBackupImage(
                { ...rawVersion.image, createdAt: rawVersion.createdAt },
                metadata.assetId,
                `素材“${metadata.name}”的历史版本原图`,
                PRICE_GALLERY_LIMITS.maxProcessedBytes,
                PRICE_GALLERY_LIMITS.maxFullSide,
                versionId,
              );
              const versionThumbnail = await validateGalleryBackupImage(
                { ...rawVersion.thumbnail, createdAt: rawVersion.createdAt },
                metadata.assetId,
                `素材“${metadata.name}”的历史版本缩略图`,
                PRICE_GALLERY_LIMITS.maxThumbnailBytes,
                PRICE_GALLERY_LIMITS.maxThumbnailSide,
                versionId,
              );
              versionImage.createdAt = rawVersion.createdAt;
              versionThumbnail.createdAt = rawVersion.createdAt;
              versions.push({
                versionId,
                createdAt: rawVersion.createdAt,
                image: versionImage,
                thumbnail: versionThumbnail,
              });
            }
            validated.push({ metadata, image, thumbnail, versions });
          } catch (error) {
            failures.push(galleryBackupErrorMessage(error));
          }
        }
        if (failures.length) {
          const details = failures.slice(0, 5).join("\n");
          const more =
            failures.length > 5
              ? `\n另有${failures.length - 5}项错误。`
              : "";
          const error = createGalleryBackupError(
            `备份校验失败：失败${failures.length}张。\n${details}${more}`,
          );
          error.failedCount = failures.length;
          throw error;
        }
        if (
          rawBackup.schemaVersion >= 2 &&
          (!Number.isInteger(rawBackup.versionCount) ||
            rawBackup.versionCount !==
              validated.reduce(
                (total, asset) => total + asset.versions.length,
                0,
              ))
        ) {
          throw createGalleryBackupError(
            "备份声明的历史版本数量不一致。",
          );
        }
        return validated;
      }
      function priceGalleryBackupFilename(date = new Date()) {
        const two = (value) => String(value).padStart(2, "0");
        return `价格图素材库备份_${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_${two(date.getHours())}-${two(date.getMinutes())}.json`;
      }
      async function serializeGalleryBackupImage(record, label) {
        if (!(record?.blob instanceof Blob)) {
          throw createGalleryBackupError(`${label}缺失，已停止备份。`);
        }
        if (
          record.assetId === undefined ||
          record.mimeType !== "image/webp" ||
          record.blob.type !== "image/webp"
        ) {
          throw createGalleryBackupError(`${label}格式异常，已停止备份。`);
        }
        if (record.size !== record.blob.size) {
          throw createGalleryBackupError(`${label}大小记录不一致，已停止备份。`);
        }
        return {
          assetId: record.assetId,
          ...(record.versionId ? { versionId: record.versionId } : {}),
          mimeType: record.mimeType,
          width: record.width,
          height: record.height,
          size: record.size,
          ...(record.versionId
            ? {
                createdAt: record.createdAt || "",
                originalName: record.originalName || "",
                originalType: record.originalType || "",
                originalSize: record.originalSize || 0,
              }
            : {}),
          data: await galleryBlobToBase64(record.blob),
        };
      }
      async function backupPriceGallery() {
        if (
          galleryStorageBusy ||
          galleryUploadBusy ||
          galleryUploadState ||
          galleryEditState ||
          galleryReplaceState ||
          galleryVersionDialogState
        ) {
          return;
        }
        setGalleryStorageBusy("backup");
        try {
          const assets = [];
          for (const metadata of priceGalleryMeta) {
            const [imageRecord, thumbnailRecord] = await Promise.all([
              getPriceGalleryBlobRecord(
                PRICE_GALLERY_IMAGE_STORE,
                metadata.assetId,
              ),
              getPriceGalleryBlobRecord(
                PRICE_GALLERY_THUMBNAIL_STORE,
                metadata.assetId,
              ),
            ]);
            if (imageRecord?.assetId !== metadata.assetId) {
              throw createGalleryBackupError(
                `素材“${metadata.name}”缺少对应原图，未生成备份。`,
              );
            }
            if (thumbnailRecord?.assetId !== metadata.assetId) {
              throw createGalleryBackupError(
                `素材“${metadata.name}”缺少对应缩略图，未生成备份。`,
              );
            }
            const versionRecords = await getPriceGalleryVersions(
              metadata.assetId,
            );
            const versions = [];
            for (const { image, thumbnail } of versionRecords) {
              if (
                image?.assetId !== metadata.assetId ||
                thumbnail?.assetId !== metadata.assetId ||
                image.versionId !== thumbnail.versionId
              ) {
                throw createGalleryBackupError(
                  `素材“${metadata.name}”的历史版本记录不完整，未生成备份。`,
                );
              }
              versions.push({
                versionId: image.versionId,
                createdAt: image.createdAt || thumbnail.createdAt || "",
                image: await serializeGalleryBackupImage(
                  image,
                  `素材“${metadata.name}”的历史版本原图`,
                ),
                thumbnail: await serializeGalleryBackupImage(
                  thumbnail,
                  `素材“${metadata.name}”的历史版本缩略图`,
                ),
              });
            }
            assets.push({
              metadata: { ...metadata },
              image: await serializeGalleryBackupImage(
                imageRecord,
                `素材“${metadata.name}”的原图`,
              ),
              thumbnail: await serializeGalleryBackupImage(
                thumbnailRecord,
                `素材“${metadata.name}”的缩略图`,
              ),
              versions,
            });
          }
          const backup = {
            backupType: PRICE_GALLERY_BACKUP_TYPE,
            schemaVersion: PRICE_GALLERY_BACKUP_SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            assetCount: assets.length,
            versionCount: assets.reduce(
              (total, asset) => total + asset.versions.length,
              0,
            ),
            assets,
          };
          await validatePriceGalleryBackup(backup);
          const json = JSON.stringify(backup, null, 2);
          if (new Blob([json]).size > PRICE_GALLERY_BACKUP_MAX_BYTES) {
            throw createGalleryBackupError(
              "价格图库备份超过256MB，请减少素材数量后重试。",
            );
          }
          download(priceGalleryBackupFilename(), json);
          toast(`图库备份已生成，共${assets.length}张素材`);
        } catch (error) {
          alert(galleryBackupErrorMessage(error));
        } finally {
          setGalleryStorageBusy("");
        }
      }
      function selectPriceGalleryBackupFile() {
        if (
          galleryStorageBusy ||
          galleryUploadBusy ||
          galleryUploadState ||
          galleryEditState ||
          galleryReplaceState ||
          galleryVersionDialogState
        ) {
          return;
        }
        $("#priceGalleryBackupInput")?.click();
      }
      function handlePriceGalleryBackupInput(event) {
        const input = event.currentTarget;
        const file = input.files?.[0];
        input.value = "";
        if (file) restorePriceGalleryBackup(file);
      }
      async function verifyRestoredGalleryAsset(asset) {
        const [image, thumbnail] = await Promise.all([
          getPriceGalleryBlobRecord(
            PRICE_GALLERY_IMAGE_STORE,
            asset.metadata.assetId,
          ),
          getPriceGalleryBlobRecord(
            PRICE_GALLERY_THUMBNAIL_STORE,
            asset.metadata.assetId,
          ),
        ]);
        if (
          !(image?.blob instanceof Blob) ||
          !(thumbnail?.blob instanceof Blob) ||
          image.blob.size !== asset.image.blob.size ||
          thumbnail.blob.size !== asset.thumbnail.blob.size ||
          image.width !== asset.image.width ||
          image.height !== asset.image.height ||
          thumbnail.width !== asset.thumbnail.width ||
          thumbnail.height !== asset.thumbnail.height
        ) {
          throw createGalleryBackupError(
            `素材“${asset.metadata.name}”写入后验证失败。`,
          );
        }
      }
      async function restorePriceGalleryBackup(file) {
        if (
          galleryStorageBusy ||
          galleryUploadBusy ||
          galleryUploadState ||
          galleryEditState ||
          galleryReplaceState ||
          galleryVersionDialogState ||
          !ensurePriceGalleryMetaWritable()
        ) {
          return;
        }
        setGalleryStorageBusy("restore");
        let skippedCount = 0;
        let skippedVersionCount = 0;
        let pendingCount = 0;
        let writtenIds = [];
        let writtenVersionIds = [];
        try {
          if (!/\.json$/i.test(file.name || "")) {
            throw createGalleryBackupError(
              galleryErrorMessage(createGalleryError("BACKUP_NOT_JSON")),
            );
          }
          if (file.size > PRICE_GALLERY_BACKUP_MAX_BYTES) {
            throw createGalleryBackupError("备份文件超过256MB，无法恢复。");
          }
          let rawBackup;
          try {
            rawBackup = JSON.parse(await file.text());
          } catch (error) {
            throw createGalleryBackupError(
              galleryErrorMessage(createGalleryError("BACKUP_NOT_JSON")),
              error,
            );
          }
          const validated = await validatePriceGalleryBackup(rawBackup);
          const [storedIds, storedVersionIds] = await Promise.all([
            getPriceGalleryStoredIds(),
            getPriceGalleryStoredVersionIds(),
          ]);
          const existingIds = new Set([
            ...priceGalleryMeta.map((asset) => asset.assetId),
            ...storedIds.imageIds.map(String),
            ...storedIds.thumbnailIds.map(String),
          ]);
          const additions = validated.filter((asset) => {
            if (existingIds.has(asset.metadata.assetId)) {
              skippedCount += 1;
              return false;
            }
            return true;
          });
          const acceptedAssetIds = new Set([
            ...priceGalleryMeta.map((asset) => asset.assetId),
            ...additions.map((asset) => asset.metadata.assetId),
          ]);
          const existingVersionIds = new Set([
            ...storedVersionIds.imageIds.map(String),
            ...storedVersionIds.thumbnailIds.map(String),
          ]);
          const versionAdditions = validated.flatMap((asset) =>
            asset.versions
              .filter((version) => {
                if (
                  !acceptedAssetIds.has(asset.metadata.assetId) ||
                  existingVersionIds.has(version.versionId)
                ) {
                  skippedVersionCount += 1;
                  return false;
                }
                existingVersionIds.add(version.versionId);
                return true;
              })
              .map((version) => ({
                ...version,
                assetId: asset.metadata.assetId,
              })),
          );
          pendingCount = additions.length + versionAdditions.length;
          if (!additions.length && !versionAdditions.length) {
            toast(
              `恢复完成：新增0张，跳过${skippedCount}张，新增版本0个，跳过版本${skippedVersionCount}个，失败0张`,
            );
            return;
          }
          await checkPriceGalleryRestoreSpace(
            additions.map((asset) => ({ ...asset, versions: [] })),
            versionAdditions,
          );
          await addPriceGalleryRestoreRecords(additions, versionAdditions);
          writtenIds = additions.map((asset) => asset.metadata.assetId);
          writtenVersionIds = versionAdditions.map(
            (version) => version.versionId,
          );
          for (const asset of additions) {
            await verifyRestoredGalleryAsset(asset);
          }
          for (const version of versionAdditions) {
            const [image, thumbnail] = await Promise.all([
              getPriceGalleryVersionRecord(
                PRICE_GALLERY_VERSION_STORE,
                version.versionId,
              ),
              getPriceGalleryVersionRecord(
                PRICE_GALLERY_VERSION_THUMBNAIL_STORE,
                version.versionId,
              ),
            ]);
            if (
              image?.assetId !== version.assetId ||
              thumbnail?.assetId !== version.assetId ||
              image?.blob?.size !== version.image.blob.size ||
              thumbnail?.blob?.size !== version.thumbnail.blob.size
            ) {
              throw createGalleryBackupError(
                `历史版本${version.versionId}写入后验证失败。`,
              );
            }
          }
          const firstRestoreOrder =
            priceGalleryMeta.reduce(
              (highest, asset) => Math.max(highest, asset.customOrder),
              -1,
            ) + 1;
          const restoredMetadata = additions
            .map((asset) => asset.metadata)
            .sort((a, b) => a.customOrder - b.customOrder)
            .map((metadata, index) => ({
              ...metadata,
              customOrder: firstRestoreOrder + index,
            }));
          try {
            if (restoredMetadata.length) {
              persistPriceGalleryMeta([
                ...priceGalleryMeta,
                ...restoredMetadata,
              ]);
            }
          } catch (error) {
            throw createGalleryBackupError(
              galleryBackupErrorMessage(error),
              error,
            );
          }
          writtenIds = [];
          writtenVersionIds = [];
          if (mode === "gallery") renderPriceGalleryResults();
          toast(
            `恢复完成：新增${additions.length}张，跳过${skippedCount}张，新增版本${versionAdditions.length}个，跳过版本${skippedVersionCount}个，失败0张，当前共${priceGalleryMeta.length}张`,
          );
        } catch (error) {
          if (writtenIds.length || writtenVersionIds.length) {
            try {
              await deletePriceGalleryRestoreRecords(
                writtenIds,
                writtenVersionIds,
              );
            } catch (rollbackError) {
              alert(
                `${galleryBackupErrorMessage(error)}\n自动回滚未完全成功，请停止继续恢复并检查浏览器存储。`,
              );
              return;
            }
          }
          const failedCount = error?.failedCount || pendingCount;
          const summary = failedCount
            ? `\n新增0张，跳过${skippedCount}张，失败${failedCount}项，现有素材保持不变。`
            : "\n未写入任何数据，现有素材保持不变。";
          alert(`${galleryBackupErrorMessage(error)}${summary}`);
        } finally {
          setGalleryStorageBusy("");
        }
      }
      function clearGalleryAssetDropIndicators() {
        document
          .querySelectorAll(
            ".gallery-card.is-dragging, .gallery-card.drop-before, .gallery-card.drop-after",
          )
          .forEach((card) =>
            card.classList.remove(
              "is-dragging",
              "drop-before",
              "drop-after",
            ),
          );
      }
      function activateGalleryAssetDrag() {
        if (!galleryAssetDragState || galleryAssetDragState.active) return;
        if (galleryViewState.sort !== "custom" || mode !== "gallery") {
          finishGalleryAssetDrag(null, false);
          return;
        }
        galleryAssetDragState.active = true;
        galleryAssetDragState.handle.setAttribute("aria-grabbed", "true");
        document
          .querySelector(
            `.gallery-card[data-asset-id="${CSS.escape(galleryAssetDragState.sourceId)}"]`,
          )
          ?.classList.add("is-dragging");
      }
      function startGalleryAssetDrag(event, assetId) {
        if (
          galleryViewState.sort !== "custom" ||
          mode !== "gallery" ||
          galleryAssetDragState ||
          galleryUploadBusy ||
          galleryStorageBusy ||
          galleryEditState ||
          (event.pointerType === "mouse" && event.button !== 0)
        ) {
          return;
        }
        event.stopPropagation();
        if (event.pointerType === "mouse") event.preventDefault();
        const handle = event.currentTarget;
        galleryAssetDragState = {
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          handle,
          sourceId: assetId,
          targetId: "",
          after: false,
          active: false,
          startX: event.clientX,
          startY: event.clientY,
          timer: null,
        };
        handle.setPointerCapture?.(event.pointerId);
        if (event.pointerType === "touch") {
          galleryAssetDragState.timer = setTimeout(
            activateGalleryAssetDrag,
            320,
          );
        } else {
          activateGalleryAssetDrag();
        }
      }
      function updateGalleryAssetDropTarget(clientX, clientY) {
        if (!galleryAssetDragState?.active) return;
        const cards = [...document.querySelectorAll(".gallery-card")].filter(
          (card) => card.dataset.assetId !== galleryAssetDragState.sourceId,
        );
        clearGalleryAssetDropIndicators();
        document
          .querySelector(
            `.gallery-card[data-asset-id="${CSS.escape(galleryAssetDragState.sourceId)}"]`,
          )
          ?.classList.add("is-dragging");
        if (!cards.length) {
          galleryAssetDragState.targetId = "";
          return;
        }
        const target = cards.reduce((nearest, card) => {
          const rect = card.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const distance = Math.hypot(clientX - centerX, clientY - centerY);
          return !nearest || distance < nearest.distance
            ? { card, rect, centerX, centerY, distance }
            : nearest;
        }, null);
        const sameRow =
          Math.abs(clientY - target.centerY) <= target.rect.height * 0.32;
        const after = sameRow
          ? clientX > target.centerX
          : clientY > target.centerY;
        galleryAssetDragState.targetId = target.card.dataset.assetId || "";
        galleryAssetDragState.after = after;
        target.card.classList.add(after ? "drop-after" : "drop-before");
      }
      function autoScrollPriceGallery(clientY) {
        if (!galleryAssetDragState?.active) return;
        const scroller = $(".main");
        if (!scroller) return;
        const rect = scroller.getBoundingClientRect();
        const edge = Math.min(72, rect.height / 4);
        let delta = 0;
        if (clientY < rect.top + edge) delta = -16;
        else if (clientY > rect.bottom - edge) delta = 16;
        if (delta) scroller.scrollBy({ top: delta });
      }
      function handleGalleryAssetPointerMove(event) {
        if (
          !galleryAssetDragState ||
          event.pointerId !== galleryAssetDragState.pointerId
        ) {
          return;
        }
        if (!galleryAssetDragState.active) {
          const distance = Math.hypot(
            event.clientX - galleryAssetDragState.startX,
            event.clientY - galleryAssetDragState.startY,
          );
          if (distance > 10) finishGalleryAssetDrag(event, false);
          return;
        }
        event.preventDefault();
        autoScrollPriceGallery(event.clientY);
        updateGalleryAssetDropTarget(event.clientX, event.clientY);
      }
      function reorderVisiblePriceGalleryAssets(sourceId, targetId, after) {
        if (
          galleryViewState.sort !== "custom" ||
          sourceId === targetId ||
          galleryUploadBusy ||
          galleryStorageBusy ||
          galleryEditState ||
          !ensurePriceGalleryMetaWritable()
        ) {
          return false;
        }
        const visibleAssets = getFilteredPriceGalleryAssets();
        const visibleIds = visibleAssets.map((asset) => asset.assetId);
        const sourceIndex = visibleIds.indexOf(sourceId);
        if (sourceIndex < 0 || !visibleIds.includes(targetId)) return false;
        visibleIds.splice(sourceIndex, 1);
        const targetIndex = visibleIds.indexOf(targetId);
        visibleIds.splice(targetIndex + (after ? 1 : 0), 0, sourceId);
        const visibleSet = new Set(visibleIds);
        const fullOrder = getPriceGalleryAssets().sort(
          (a, b) => a.sortOrder - b.sortOrder || a.sourceIndex - b.sourceIndex,
        );
        let visibleIndex = 0;
        const mergedIds = fullOrder.map((asset) =>
          visibleSet.has(asset.assetId)
            ? visibleIds[visibleIndex++]
            : asset.assetId,
        );
        const customOrderById = new Map(
          mergedIds.map((assetId, index) => [assetId, index]),
        );
        const nextMeta = priceGalleryMeta.map((asset) => ({
          ...asset,
          customOrder: customOrderById.get(asset.assetId),
        }));
        try {
          persistPriceGalleryMeta(nextMeta);
        } catch (error) {
          showGalleryError(error);
          return false;
        }
        renderPriceGalleryResults();
        toast("自定义顺序已保存");
        return true;
      }
      function finishGalleryAssetDrag(event, commit = true) {
        if (
          !galleryAssetDragState ||
          (event?.pointerId != null &&
            event.pointerId !== galleryAssetDragState.pointerId)
        ) {
          return;
        }
        const state = galleryAssetDragState;
        clearTimeout(state.timer);
        state.handle.setAttribute("aria-grabbed", "false");
        if (state.handle.hasPointerCapture?.(state.pointerId)) {
          state.handle.releasePointerCapture(state.pointerId);
        }
        galleryAssetDragState = null;
        clearGalleryAssetDropIndicators();
        if (commit && state.active && state.targetId) {
          reorderVisiblePriceGalleryAssets(
            state.sourceId,
            state.targetId,
            state.after,
          );
        }
      }
      function handleGalleryAssetHandleKeydown(event, assetId) {
        if (galleryViewState.sort !== "custom") return;
        const backward = ["ArrowUp", "ArrowLeft"].includes(event.key);
        const forward = ["ArrowDown", "ArrowRight"].includes(event.key);
        if (!backward && !forward) return;
        event.preventDefault();
        event.stopPropagation();
        const visibleIds = getFilteredPriceGalleryAssets().map(
          (asset) => asset.assetId,
        );
        const index = visibleIds.indexOf(assetId);
        const nextIndex = index + (backward ? -1 : 1);
        if (index < 0 || nextIndex < 0 || nextIndex >= visibleIds.length) return;
        const targetId = visibleIds[nextIndex];
        if (reorderVisiblePriceGalleryAssets(assetId, targetId, forward)) {
          requestAnimationFrame(() =>
            document
              .querySelector(
                `.gallery-card[data-asset-id="${CSS.escape(assetId)}"] .gallery-card-drag-handle`,
              )
              ?.focus(),
          );
        }
      }
      function renderPriceGalleryCard(asset) {
        const deleted = Boolean(asset.deletedAt);
        const statusLabel = deleted
          ? "已删除"
          : asset.status === "history"
            ? "历史状态"
            : "当前使用";
        const statusAction =
          asset.status === "history" ? "恢复为当前使用" : "移入历史";
        const note = asset.note || "暂无备注";
        const dragHandle =
          galleryViewState.sort === "custom" && !deleted
            ? `<button type="button" class="gallery-card-drag-handle" aria-label="拖动调整“${esc(asset.name)}”的自定义顺序" title="拖动调整自定义顺序" aria-grabbed="false" onpointerdown="startGalleryAssetDrag(event,this.closest('.gallery-card').dataset.assetId)" onkeydown="handleGalleryAssetHandleKeydown(event,this.closest('.gallery-card').dataset.assetId)" onclick="event.preventDefault();event.stopPropagation()">⠿</button>`
            : "";
        const imageHtml = `<button type="button" class="gallery-thumb-button" data-gallery-action="zoom" aria-label="放大查看：${esc(asset.name)}"><img alt="${esc(asset.name)}" loading="lazy" hidden onerror="handleGalleryThumbnailError(this)"></button><div class="gallery-thumb-fallback">正在加载缩略图…</div>`;
        const actions = deleted
          ? `<button type="button" class="btn" data-gallery-action="download">下载</button><button type="button" class="btn" data-gallery-action="versions">版本</button><button type="button" class="btn primary" data-gallery-action="restore">恢复</button><button type="button" class="btn danger" data-gallery-action="permanent-delete">永久删除</button>`
          : `<button type="button" class="btn" data-gallery-action="copy">复制</button><button type="button" class="btn" data-gallery-action="download">下载</button><button type="button" class="btn" data-gallery-action="edit">编辑</button><details class="gallery-more"><summary data-gallery-action="toggle-menu">更多</summary><div class="gallery-more-menu"><button type="button" data-gallery-action="replace">替换图片</button><button type="button" data-gallery-action="versions">查看历史版本</button><button type="button" data-gallery-action="toggle-status">${statusAction}</button><button type="button" class="danger" data-gallery-action="recycle">删除</button></div></details>`;
        return `<article class="gallery-card ${deleted ? "is-deleted" : ""}" data-asset-id="${esc(asset.assetId)}">${dragHandle}<div class="gallery-thumb">${imageHtml}</div><div class="gallery-card-body"><div class="gallery-card-tags"><span class="gallery-status ${deleted ? "deleted" : asset.status}">${statusLabel}</span><span class="gallery-product">${esc(asset.product)}</span></div><h2>${esc(asset.name)}</h2><p class="gallery-note">${esc(note)}</p><dl class="gallery-dates"><div><dt>上传时间</dt><dd>${esc(formatGalleryDate(asset.uploadedAt))}</dd></div><div><dt>${deleted ? "删除时间" : "最后更新"}</dt><dd>${esc(formatGalleryDate(deleted ? asset.deletedAt : asset.updatedAt))}</dd></div></dl><div class="gallery-card-actions" aria-label="${esc(asset.name)}的操作">${actions}</div></div></article>`;
      }
      function renderPriceGalleryResults() {
        if (mode !== "gallery") return;
        finishGalleryAssetDrag(null, false);
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
        const activeCount = priceGalleryMeta.filter(
          (asset) => !asset.deletedAt,
        ).length;
        results.innerHTML = activeCount || galleryViewState.status === "deleted"
          ? '<div class="gallery-empty"><b>没有符合条件的价格图</b><span>可调整搜索词或筛选条件。</span></div>'
          : '<div class="gallery-empty"><b>暂无价格图，可通过上传或粘贴添加</b><span>价格图仅保存在当前浏览器，不会自动跨设备同步。</span></div>';
      }
      function updatePriceGalleryFilter(key, value) {
        if (!["query", "product", "status", "sort"].includes(key)) return;
        closeGalleryMenus();
        galleryViewState[key] = String(value || "");
        renderPriceGalleryResults();
        persistUiState();
      }
      function renderPriceGallery() {
        const productOptions = [
          ["all", "全部"],
          ...GALLERY_PRODUCTS.map((product) => [product, product]),
        ];
        closeGalleryMenus();
        $("#main").innerHTML = `<section class="gallery-shell" aria-labelledby="galleryTitle"><header class="gallery-header"><div><p class="gallery-eyebrow">产品价格图</p><h1 id="galleryTitle">价格图素材库</h1><p>上传或粘贴价格图后，原图和缩略图保存在当前浏览器。本机数据不会自动跨设备同步。</p></div><div class="gallery-header-actions"><button type="button" class="btn gallery-backup" onclick="backupPriceGallery()">备份图库</button><button type="button" class="btn gallery-restore" onclick="selectPriceGalleryBackupFile()">恢复图库</button><button type="button" class="btn primary gallery-upload" onclick="selectPriceGalleryFile()">上传价格图</button><input id="priceGalleryBackupInput" type="file" accept="application/json,.json" aria-label="选择价格图库备份文件" hidden onchange="handlePriceGalleryBackupInput(event)"><input id="priceGalleryFileInput" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" aria-label="选择价格图文件" hidden onchange="handlePriceGalleryFileInput(event)"></div></header><div class="gallery-toolbar" role="search" aria-label="价格图筛选"><label class="gallery-search-field"><span>搜索</span><input id="gallerySearch" type="search" value="${esc(galleryViewState.query)}" placeholder="搜索图片名称、备注或产品" oninput="updatePriceGalleryFilter('query',this.value)"></label><label><span>产品分类</span><select onchange="updatePriceGalleryFilter('product',this.value)">${gallerySelectOptions(productOptions, galleryViewState.product)}</select></label><label><span>状态</span><select onchange="updatePriceGalleryFilter('status',this.value)">${gallerySelectOptions([["all", "全部"], ["current", "当前使用"], ["history", "历史"], ["deleted", "已删除 / 回收站"]], galleryViewState.status)}</select></label><label><span>排序方式</span><select onchange="updatePriceGalleryFilter('sort',this.value)">${gallerySelectOptions([["custom", "自定义排序"], ["updated", "最近更新"], ["uploaded", "最近上传"], ["name", "名称排序"]], galleryViewState.sort)}</select></label></div><div class="gallery-subbar"><p>在图库空白区域按 Command+V / Ctrl+V，可粘贴从微信复制的图片；一次处理 1 张。</p><strong id="gallerySummary"></strong></div><div id="galleryResults" aria-live="polite"></div></section>`;
        bindPriceGalleryResultEvents();
        refreshGalleryActionButtons();
        renderPriceGalleryResults();
      }
      function openPriceGallery(gi) {
        if (!isProductCenterGroup(groups[gi])) return;
        activeG = gi;
        activeI = 0;
        activeArticleVisible = false;
        editing = false;
        setMode("gallery");
        renderNav();
        renderGroupList(gi);
        renderPriceGallery();
        runLegacyPriceGalleryMigration();
        persistUiState();
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
        const previousArticleOrder = structuredClone(articleOrder);
        const sourceOrder = getEffectiveArticleOrderIds(current.gi);
        const sourceOrderIndex = sourceOrder.indexOf(contentId);
        const targetOrder = getEffectiveArticleOrderIds(targetIndex);
        let nextArticleOrder = removeArticleFromOrderState(
          articleOrder,
          contentId,
        );
        nextArticleOrder = setArticleOrderForGroup(
          nextArticleOrder,
          current.gi,
          sourceOrder.filter((savedId) => savedId !== contentId),
        );
        nextArticleOrder = setArticleOrderForGroup(
          nextArticleOrder,
          targetIndex,
          [
            contentId,
            ...targetOrder.filter((savedId) => savedId !== contentId),
          ],
        );
        if (!persistArticleOrder(nextArticleOrder)) return;
        articleCategoryOverrides[contentId] = {
          content_id: contentId,
          source_category_id:
            previousOverride?.source_category_id || sourceCategoryId,
          target_category_id: targetCategoryId,
          moved_at: new Date().toISOString(),
        };
        if (!persistArticleCategoryOverrides()) {
          persistArticleOrder(previousArticleOrder);
          if (previousOverride) {
            articleCategoryOverrides[contentId] = previousOverride;
          } else {
            delete articleCategoryOverrides[contentId];
          }
          return;
        }
        const result = relocateArticleByContentId(contentId, targetCategoryId);
        if (!result) {
          persistArticleOrder(previousArticleOrder);
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
          sourceOrderIndex,
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
        const previousArticleOrder = structuredClone(articleOrder);
        const current = findArticleByContentId(state.contentId);
        const sourceIndex = findGroupIndexByCategoryId(state.sourceCategoryId);
        const targetOrder = getEffectiveArticleOrderIds(current.gi);
        const sourceOrder = getEffectiveArticleOrderIds(sourceIndex).filter(
          (contentId) => contentId !== state.contentId,
        );
        const restoreIndex = Math.max(
          0,
          Math.min(
            Number.isInteger(state.sourceOrderIndex)
              ? state.sourceOrderIndex
              : 0,
            sourceOrder.length,
          ),
        );
        sourceOrder.splice(restoreIndex, 0, state.contentId);
        let restoredArticleOrder = removeArticleFromOrderState(
          articleOrder,
          state.contentId,
        );
        restoredArticleOrder = setArticleOrderForGroup(
          restoredArticleOrder,
          current.gi,
          targetOrder.filter((contentId) => contentId !== state.contentId),
        );
        restoredArticleOrder = setArticleOrderForGroup(
          restoredArticleOrder,
          sourceIndex,
          sourceOrder,
        );
        if (!persistArticleOrder(restoredArticleOrder)) return;
        if (state.previousOverride) {
          articleCategoryOverrides[state.contentId] = structuredClone(
            state.previousOverride,
          );
        } else {
          delete articleCategoryOverrides[state.contentId];
        }
        if (!persistArticleCategoryOverrides()) {
          persistArticleOrder(previousArticleOrder);
          articleCategoryOverrides[state.contentId] = currentOverride;
          return;
        }
        const result = relocateArticleByContentId(
          state.contentId,
          state.sourceCategoryId,
        );
        if (!result) {
          persistArticleOrder(previousArticleOrder);
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
      function normalizeArticleOrderIds(values) {
        if (!Array.isArray(values)) return [];
        const seen = new Set();
        return values
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((contentId) => {
            if (
              !isStableContentId(contentId) ||
              seen.has(contentId)
            ) {
              return false;
            }
            seen.add(contentId);
            return true;
          });
      }
      function loadArticleOrder() {
        try {
          const parsed = JSON.parse(
            localStorage.getItem(ARTICLE_ORDER_KEY) || "{}",
          );
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
          }
          const normalized = {};
          Object.entries(parsed).forEach(([categoryId, values]) => {
            const stableCategoryId = String(categoryId || "").trim();
            if (!stableCategoryId || !Array.isArray(values)) return;
            normalized[stableCategoryId] = normalizeArticleOrderIds(values);
          });
          return normalized;
        } catch (error) {
          return {};
        }
      }
      function persistArticleOrder(nextOrder) {
        const normalized = {};
        Object.entries(nextOrder || {}).forEach(([categoryId, values]) => {
          const stableCategoryId = String(categoryId || "").trim();
          if (!stableCategoryId || !Array.isArray(values)) return;
          normalized[stableCategoryId] = normalizeArticleOrderIds(values);
        });
        try {
          localStorage.setItem(ARTICLE_ORDER_KEY, JSON.stringify(normalized));
          articleOrder = normalized;
          return true;
        } catch (error) {
          toast("文章顺序保存失败");
          return false;
        }
      }
      function getEffectiveArticleOrderIds(groupIndex, orderState = articleOrder) {
        const group = groups[groupIndex];
        if (!group) return [];
        const categoryId = getCategoryOrderId(group, groupIndex);
        const currentIds = group.items
          .map((article) => article?.content_id)
          .filter(isStableContentId);
        const currentSet = new Set(currentIds);
        const ordered = normalizeArticleOrderIds(orderState?.[categoryId]).filter(
          (contentId) => currentSet.has(contentId),
        );
        const used = new Set(ordered);
        currentIds.forEach((contentId) => {
          if (used.has(contentId)) return;
          used.add(contentId);
          ordered.push(contentId);
        });
        return ordered;
      }
      function setArticleOrderForGroup(orderState, groupIndex, contentIds) {
        const group = groups[groupIndex];
        if (!group) return structuredClone(orderState || {});
        const next = structuredClone(orderState || {});
        next[getCategoryOrderId(group, groupIndex)] =
          normalizeArticleOrderIds(contentIds);
        return next;
      }
      function removeArticleFromOrderState(orderState, contentId) {
        const next = structuredClone(orderState || {});
        Object.keys(next).forEach((categoryId) => {
          next[categoryId] = normalizeArticleOrderIds(next[categoryId]).filter(
            (savedId) => savedId !== contentId,
          );
        });
        return next;
      }
      function getOrderedArticleRecords(groupIndex) {
        const group = groups[groupIndex];
        if (!group) return [];
        const records = group.items.map((x, ii) => ({
          g: group,
          gi: groupIndex,
          x,
          ii,
        }));
        const recordsById = new Map();
        records.forEach((record) => {
          const contentId = record.x?.content_id;
          if (isStableContentId(contentId) && !recordsById.has(contentId)) {
            recordsById.set(contentId, record);
          }
        });
        const ordered = [];
        const used = new Set();
        getEffectiveArticleOrderIds(groupIndex).forEach((contentId) => {
          const record = recordsById.get(contentId);
          if (!record || used.has(record)) return;
          used.add(record);
          ordered.push(record);
        });
        records.forEach((record) => {
          if (!used.has(record)) ordered.push(record);
        });
        return ordered;
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
      function clearArticleDropIndicators() {
        document
          .querySelectorAll(
            ".docitem.article-sortable.is-dragging, .docitem.article-sortable.drop-before, .docitem.article-sortable.drop-after",
          )
          .forEach((item) =>
            item.classList.remove(
              "is-dragging",
              "drop-before",
              "drop-after",
            ),
          );
      }
      function findArticleSortCard(contentId) {
        return [
          ...document.querySelectorAll(".docitem.article-sortable"),
        ].find((item) => item.dataset.contentId === contentId);
      }
      function activateArticleDrag() {
        if (!articleDragState || articleDragState.active) return;
        if (
          mode !== "group" ||
          $("#q").value.trim() ||
          articleDragState.groupIndex !== activeG
        ) {
          finishArticleDrag(null, false);
          return;
        }
        articleDragState.active = true;
        articleDragState.handle.setAttribute("aria-grabbed", "true");
        findArticleSortCard(articleDragState.contentId)?.classList.add(
          "is-dragging",
        );
      }
      function startArticleDrag(event, contentId) {
        if (
          (event.pointerType === "mouse" && event.button !== 0) ||
          articleDragState ||
          mode !== "group" ||
          $("#q").value.trim() ||
          !isStableContentId(contentId)
        ) {
          return;
        }
        const article = findArticleByContentId(contentId);
        if (!article || article.gi !== activeG) return;
        event.stopPropagation();
        if (event.pointerType === "mouse") event.preventDefault();
        const handle = event.currentTarget;
        articleDragState = {
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          handle,
          contentId,
          groupIndex: activeG,
          targetContentId: null,
          after: false,
          active: false,
          startX: event.clientX,
          startY: event.clientY,
          timer: null,
        };
        handle.setPointerCapture?.(event.pointerId);
        if (event.pointerType === "touch") {
          articleDragState.timer = setTimeout(activateArticleDrag, 320);
        } else {
          activateArticleDrag();
        }
      }
      function updateArticleDropTarget(clientY) {
        if (!articleDragState?.active) return;
        const items = [
          ...document.querySelectorAll(".docitem.article-sortable"),
        ].filter(
          (item) => item.dataset.contentId !== articleDragState.contentId,
        );
        clearArticleDropIndicators();
        findArticleSortCard(articleDragState.contentId)?.classList.add(
          "is-dragging",
        );
        if (!items.length) {
          articleDragState.targetContentId = null;
          return;
        }
        const target = items.reduce((nearest, item) => {
          const rect = item.getBoundingClientRect();
          const center = rect.top + rect.height / 2;
          const distance = Math.abs(clientY - center);
          return !nearest || distance < nearest.distance
            ? { item, center, distance }
            : nearest;
        }, null);
        const targetContentId = target.item.dataset.contentId;
        if (!isStableContentId(targetContentId)) {
          articleDragState.targetContentId = null;
          return;
        }
        const after = clientY > target.center;
        articleDragState.targetContentId = targetContentId;
        articleDragState.after = after;
        target.item.classList.add(after ? "drop-after" : "drop-before");
      }
      function autoScrollArticleList(clientY) {
        if (!articleDragState?.active) return;
        const scroller = $(".middle");
        if (!scroller) return;
        const rect = scroller.getBoundingClientRect();
        const edge = Math.min(58, rect.height / 4);
        let delta = 0;
        if (clientY < rect.top + edge) delta = -16;
        else if (clientY > rect.bottom - edge) delta = 16;
        if (delta) scroller.scrollBy({ top: delta });
      }
      function handleArticlePointerMove(event) {
        if (
          !articleDragState ||
          event.pointerId !== articleDragState.pointerId
        ) {
          return;
        }
        if (!articleDragState.active) {
          const distance = Math.hypot(
            event.clientX - articleDragState.startX,
            event.clientY - articleDragState.startY,
          );
          if (distance > 10) finishArticleDrag(event, false);
          return;
        }
        event.preventDefault();
        autoScrollArticleList(event.clientY);
        updateArticleDropTarget(event.clientY);
      }
      function moveArticleWithinGroup(
        groupIndex,
        contentId,
        targetContentId,
        after,
      ) {
        if (
          mode !== "group" ||
          groupIndex !== activeG ||
          $("#q").value.trim()
        ) {
          return false;
        }
        const order = getEffectiveArticleOrderIds(groupIndex);
        const sourcePosition = order.indexOf(contentId);
        if (
          sourcePosition < 0 ||
          !targetContentId ||
          !order.includes(targetContentId) ||
          contentId === targetContentId
        ) {
          return false;
        }
        order.splice(sourcePosition, 1);
        const targetPosition = order.indexOf(targetContentId);
        order.splice(targetPosition + (after ? 1 : 0), 0, contentId);
        const nextOrder = setArticleOrderForGroup(
          articleOrder,
          groupIndex,
          order,
        );
        if (!persistArticleOrder(nextOrder)) return false;
        renderGroupList(groupIndex);
        toast("文章顺序已保存");
        return true;
      }
      function finishArticleDrag(event, commit = true) {
        if (
          !articleDragState ||
          (event?.pointerId != null &&
            event.pointerId !== articleDragState.pointerId)
        ) {
          return;
        }
        const state = articleDragState;
        clearTimeout(state.timer);
        state.handle.setAttribute("aria-grabbed", "false");
        if (state.handle.hasPointerCapture?.(state.pointerId)) {
          state.handle.releasePointerCapture(state.pointerId);
        }
        articleDragState = null;
        clearArticleDropIndicators();
        if (
          commit &&
          state.active &&
          state.targetContentId
        ) {
          moveArticleWithinGroup(
            state.groupIndex,
            state.contentId,
            state.targetContentId,
            state.after,
          );
        }
      }
      function handleArticleDragKeydown(event, contentId) {
        const backward = event.key === "ArrowUp";
        const forward = event.key === "ArrowDown";
        if (!backward && !forward) return;
        if (mode !== "group" || $("#q").value.trim()) return;
        event.preventDefault();
        event.stopPropagation();
        const order = getEffectiveArticleOrderIds(activeG);
        const position = order.indexOf(contentId);
        const nextPosition = position + (backward ? -1 : 1);
        if (position < 0 || nextPosition < 0 || nextPosition >= order.length) {
          return;
        }
        const targetContentId = order[nextPosition];
        if (
          moveArticleWithinGroup(
            activeG,
            contentId,
            targetContentId,
            forward,
          )
        ) {
          requestAnimationFrame(() =>
            findArticleSortCard(contentId)
              ?.querySelector(".article-drag-handle")
              ?.focus(),
          );
        }
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
      function getUiScrollState() {
        return {
          articleList: Math.max(0, Number($(".middle")?.scrollTop) || 0),
          main: Math.max(0, Number($(".main")?.scrollTop) || 0),
        };
      }
      function buildUiState() {
        const categoryId =
          mode === "group" || mode === "gallery"
            ? getCategoryOrderId(groups[activeG], activeG)
            : "";
        const contentId =
          mode === "group" && activeArticleVisible
            ? getContentId(activeG, activeI)
            : "";
        return {
          version: 1,
          page: ["home", "fav", "recent", "group", "gallery"].includes(mode)
            ? mode
            : "home",
          categoryId,
          contentId: isStableContentId(contentId) ? contentId : "",
          gallery: {
            query: galleryViewState.query,
            product: galleryViewState.product,
            status: galleryViewState.status,
            sort: galleryViewState.sort,
          },
          scroll: getUiScrollState(),
        };
      }
      function persistUiState() {
        if (uiStateRestoring) return;
        try {
          sessionStorage.setItem(UI_STATE_KEY, JSON.stringify(buildUiState()));
        } catch (error) {
          // 页面状态是可选增强；浏览器禁用 sessionStorage 时保持原导航行为。
        }
      }
      function scheduleUiStateSave() {
        if (uiStateRestoring) return;
        clearTimeout(uiStateSaveTimer);
        uiStateSaveTimer = setTimeout(persistUiState, 120);
      }
      function loadUiState() {
        try {
          const raw = sessionStorage.getItem(UI_STATE_KEY);
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            parsed.version !== 1 ||
            !["home", "fav", "recent", "group", "gallery"].includes(
              parsed.page,
            )
          ) {
            return null;
          }
          return parsed;
        } catch (error) {
          return null;
        }
      }
      function normalizeUiScroll(raw) {
        const number = (value) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        };
        return {
          articleList: number(raw?.articleList),
          main: number(raw?.main),
        };
      }
      function restoreUiScroll(raw) {
        const scroll = normalizeUiScroll(raw);
        const apply = () => {
          const articleList = $(".middle");
          const main = $(".main");
          if (articleList) articleList.scrollTop = scroll.articleList;
          if (main) main.scrollTop = scroll.main;
        };
        requestAnimationFrame(() => {
          apply();
          requestAnimationFrame(() => {
            apply();
            uiStateRestoring = false;
            persistUiState();
          });
        });
      }
      function restoreGalleryViewState(raw) {
        const product = String(raw?.product || "all");
        const status = String(raw?.status || "all");
        const sort = String(raw?.sort || "custom");
        galleryViewState.query =
          typeof raw?.query === "string" ? raw.query.slice(0, 500) : "";
        galleryViewState.product =
          product === "all" || GALLERY_PRODUCTS.includes(product)
            ? product
            : "all";
        galleryViewState.status = ["all", "current", "history", "deleted"].includes(
          status,
        )
          ? status
          : "all";
        galleryViewState.sort = ["custom", "updated", "uploaded", "name"].includes(
          sort,
        )
          ? sort
          : "custom";
      }
      function showGroupListOnly(gi) {
        if (!groups[gi]) {
          showHome();
          return;
        }
        activeG = gi;
        activeI = 0;
        activeArticleVisible = false;
        editing = false;
        setMode("group");
        renderNav();
        renderGroupList(gi);
        $("#main").innerHTML = '<div class="empty">从左侧选择内容查看。</div>';
        persistUiState();
      }
      function restoreUiState() {
        const state = loadUiState();
        if (!state) {
          showHome();
          return;
        }
        uiStateRestoring = true;
        let scroll = state.scroll;
        const resetScroll = () => {
          scroll = { articleList: 0, main: 0 };
        };
        try {
          if (state.page === "home") {
            showHome();
          } else if (state.page === "fav") {
            showFavs();
          } else if (state.page === "recent") {
            showRecent();
          } else if (state.page === "group") {
            const gi = findGroupIndexByCategoryId(state.categoryId);
            if (gi < 0) {
              resetScroll();
              showHome();
            } else {
              const article = isStableContentId(state.contentId)
                ? findArticleByContentId(state.contentId)
                : null;
              if (article && article.gi === gi) {
                openDoc(gi, article.ii, { recordRecent: false });
              } else {
                showGroupListOnly(gi);
              }
            }
          } else if (state.page === "gallery") {
            restoreGalleryViewState(state.gallery);
            const savedGroupIndex = findGroupIndexByCategoryId(state.categoryId);
            const productGroupIndex = groups.findIndex(isProductCenterGroup);
            if (
              savedGroupIndex >= 0 &&
              isProductCenterGroup(groups[savedGroupIndex])
            ) {
              try {
                openPriceGallery(savedGroupIndex);
                if (mode !== "gallery") throw new Error("gallery unavailable");
              } catch (error) {
                resetScroll();
                if (productGroupIndex >= 0) openGroup(productGroupIndex);
                else showHome();
              }
            } else if (productGroupIndex >= 0) {
              resetScroll();
              openGroup(productGroupIndex);
            } else {
              resetScroll();
              showHome();
            }
          }
        } catch (error) {
          resetScroll();
          showHome();
        }
        restoreUiScroll(scroll);
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
        finishArticleDrag(null, false);
        if (m !== "gallery") {
          closeGalleryMenus();
          clearGalleryThumbnailUrls();
          closeGalleryUploadDialog(true);
          closeGalleryEditDialog(true);
          closeGalleryReplaceDialog(true);
          closeGalleryVersionDialog(true);
          finishGalleryAssetDrag(null, false);
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
        activeArticleVisible = false;
        editing = false;
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
        persistUiState();
      }
      
      function openGroup(gi) {
        activeG = gi;
        activeI = 0;
        activeArticleVisible = false;
        editing = false;
        setMode("group");
        renderNav();
        renderGroupList(gi);
        const firstArticle = getOrderedArticleRecords(gi)[0];
        if (firstArticle) {
          openDoc(gi, firstArticle.ii);
        } else {
          $("#main").innerHTML =
            '<div class="empty">当前分类还没有内容。</div>';
          persistUiState();
        }
      }
      function openDoc(gi, ii, options = {}) {
        if (!groups[gi]?.items?.[ii]) {
          showGroupListOnly(gi);
          return;
        }
        activeG = gi;
        activeI = ii;
        activeArticleVisible = true;
        setMode("group");
        let k = getContentId(gi, ii);
        if (options.recordRecent !== false) {
          recent = [k, ...recent.filter((x) => x !== k)].slice(0, 20);
          save();
        } else {
          renderNav();
        }
        renderGroupList(gi);
        renderDoc();
        persistUiState();
      }
      function renderDoc() {
        if (editing) ensureStableContentId(activeG, activeI);
        let x = groups[activeG]?.items[activeI];
        if (!x) {
          activeArticleVisible = false;
          $("#main").innerHTML = '<div class="empty">请选择内容</div>';
          return;
        }
        activeArticleVisible = true;
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
        activeArticleVisible = false;
        editing = false;
        setMode("fav");
        renderNav();
        let arr = favs.map((k) => resolveStoredIdRecord(k)).filter(Boolean);
        renderList(arr, "我的收藏");
        $("#main").innerHTML =
          '<div class="empty">从左侧选择收藏内容查看。</div>';
        persistUiState();
      }
      function showRecent() {
        activeArticleVisible = false;
        editing = false;
        setMode("recent");
        renderNav();
        let arr = recent.map((k) => resolveStoredIdRecord(k)).filter(Boolean);
        renderList(arr, "最近使用");
        $("#main").innerHTML =
          '<div class="empty">从左侧选择最近使用内容查看。</div>';
        persistUiState();
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
        const contentId = createContentId();
        groups[activeG].items.unshift({
          title: "新内容",
          content_id: contentId,
          paragraphs: ["请在这里输入内容。"],
        });
        const nextOrder = setArticleOrderForGroup(
          articleOrder,
          activeG,
          [
            contentId,
            ...getEffectiveArticleOrderIds(activeG).filter(
              (savedId) => savedId !== contentId,
            ),
          ],
        );
        if (!persistArticleOrder(nextOrder)) {
          groups[activeG].items.shift();
          return;
        }
        activeI = 0;
        save();
        editing = true;
        openDoc(activeG, activeI);
      }
      function deleteCurrent() {
        if (!confirm("确定删除这条内容吗？")) return;
        const article = groups[activeG]?.items?.[activeI];
        const contentId = article?.content_id;
        if (
          isStableContentId(contentId) &&
          !persistArticleOrder(
            removeArticleFromOrderState(articleOrder, contentId),
          )
        ) {
          return;
        }
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
              if (
                !Array.isArray(importedGroups) &&
                importedGroups?.backupType === PRICE_GALLERY_BACKUP_TYPE
              ) {
                alert(
                  '这是价格图库备份，请进入“价格图素材库”并点击“恢复图库”。',
                );
                return;
              }
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
          closeGalleryEditDialog();
          closeGalleryReplaceDialog();
          closeGalleryVersionDialog();
          finishGalleryAssetDrag(null, false);
          finishArticleDrag(null, false);
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
      document.addEventListener("pointermove", handleArticlePointerMove, {
        passive: false,
      });
      document.addEventListener("pointermove", handleGalleryAssetPointerMove, {
        passive: false,
      });
      document.addEventListener("pointerup", (event) =>
        finishCategoryDrag(event),
      );
      document.addEventListener("pointerup", (event) =>
        finishArticleDrag(event),
      );
      document.addEventListener("pointerup", (event) =>
        finishGalleryAssetDrag(event),
      );
      document.addEventListener("pointercancel", (event) =>
        finishCategoryDrag(event, false),
      );
      document.addEventListener("pointercancel", (event) =>
        finishArticleDrag(event, false),
      );
      document.addEventListener("pointercancel", (event) =>
        finishGalleryAssetDrag(event, false),
      );
      $(".main")?.addEventListener("scroll", () => {
        const openMenu = document.querySelector(".gallery-more[open]");
        if (openMenu) {
          requestAnimationFrame(() => positionGalleryMenu(openMenu));
        }
        scheduleUiStateSave();
      });
      $(".middle")?.addEventListener("scroll", scheduleUiStateSave, {
        passive: true,
      });
      window.addEventListener("pagehide", () => {
        clearTimeout(uiStateSaveTimer);
        persistUiState();
      });
      initCategoryScroller();
      renderNav();
      restoreUiState();
