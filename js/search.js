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
