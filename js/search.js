function allDocs() {
        let a = [];
        groups.forEach((g, gi) =>
          g.items.forEach((x, ii) => a.push({ g, gi, x, ii })),
        );
        return a;
      }

function renderList(arr, title) {
        if (typeof finishArticleDrag === "function") {
          finishArticleDrag(null, false);
        }
        $("#listTitle").textContent = title;
        $("#addBtn").style.display = mode === "group" ? "block" : "none";
        let q = $("#q").value.trim().toLowerCase();
        if (q)
          arr = allDocs().filter((o) =>
            (o.x.title + " " + o.x.paragraphs.join(" "))
              .toLowerCase()
              .includes(q),
          );
        const sortable =
          mode === "group" &&
          !q &&
          arr.every((o) => o.gi === activeG);
        $("#items").innerHTML =
          arr
            .map(
              (o) => {
                const contentId = getContentId(o.gi, o.ii);
                const canDrag = sortable && isStableContentId(contentId);
                return `<div class="docitem ${canDrag ? "article-sortable" : ""} ${o.gi === activeG && o.ii === activeI && mode !== "home" ? "on" : ""}"${canDrag ? ` data-content-id="${esc(contentId)}"` : ""} onclick="openDoc(${o.gi},${o.ii})"><b>${esc(o.x.title)}</b><small>${esc(getCategoryDisplayName(o.g, o.gi))} · ${esc(o.x.paragraphs.join(" ").slice(0, 55))}</small><button type="button" class="star ${favs.includes(contentId) ? "on" : ""}" aria-label="${favs.includes(contentId) ? "取消收藏" : "收藏"}" onclick="event.stopPropagation();toggleFav(${o.gi},${o.ii})">★</button>${canDrag ? `<button type="button" class="article-drag-handle" aria-label="拖动调整文章顺序" title="拖动调整文章顺序" aria-grabbed="false" onpointerdown="startArticleDrag(event,this.closest('.docitem').dataset.contentId)" onkeydown="handleArticleDragKeydown(event,this.closest('.docitem').dataset.contentId)" onclick="event.preventDefault();event.stopPropagation()">⠿</button>` : ""}</div>`;
              },
            )
            .join("") || '<div class="empty">没有找到内容</div>';
      }
