const DOCUMENT_PACK = window.KB_DOCUMENT_PACK || {};

function appendDocumentPack(group) {
  return {
    ...group,
    items: [
      ...(group.items || []),
      ...(DOCUMENT_PACK[group.category_id] || []),
    ],
  };
}

const ORIGINAL_DATA = [
  window.KB_PRESALE,
  window.KB_AFTERSALE_ONHOLD,
  window.KB_AFTERSALE_ACTIONS,
  window.KB_OTHER,
  window.KB_PRODUCTS,
  window.KB_TUTORIALS,
  window.KB_TRAINING,
].map(appendDocumentPack);
