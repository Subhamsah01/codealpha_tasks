/* Each category gets a colour derived from its name, applied to its
   chip, its tile's hover duotone, and the lightbox accent while that
   photo is open. New categories the user creates get a theme too,
   picked deterministically from the same palette. */
const PALETTE = [
  '#3f6b52', // evergreen
  '#45536b', // slate
  '#a8623f', // terracotta
  '#93752c', // amber
  '#6b4675', // plum
  '#2f6f6a', // teal
  '#9c4f5e', // rose
  '#4d6672', // steel
];
const CATEGORY_THEME = {
  'Nature': PALETTE[0],
  'Architecture': PALETTE[1],
  'Portrait': PALETTE[2],
  'Street': PALETTE[3],
  'Abstract': PALETTE[4]
};
function themeFor(cat){
  if(CATEGORY_THEME[cat]) return CATEGORY_THEME[cat];
  let hash = 0;
  for(let i=0;i<cat.length;i++){ hash = cat.charCodeAt(i) + ((hash<<5)-hash); }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/* ---------------- Data ---------------- */
// NOTE: loremflickr occasionally 500s on certain multi-tag combinations
// (in testing, 'street,city' and 'abstract,texture' consistently failed
// while the others worked). Using single, well-populated tags avoids
// that — and createFrameNode() below still has an onerror fallback in
// case any tag combo (now or in the future) fails to resolve.
const CATEGORY_KEYWORDS = {
  'Nature': 'nature,landscape',
  'Architecture': 'architecture,building',
  'Portrait': 'portrait,face',
  'Street': 'street',
  'Abstract': 'abstract'
};

let nextId = 0;
let photos = [];
function seedPhoto(cat, title, lock){
  const id = nextId++;
  const kw = CATEGORY_KEYWORDS[cat];
  photos.push({
    id, cat, title,
    src: `https://loremflickr.com/500/625/${kw}?lock=${lock}`,
    full: `https://loremflickr.com/1400/1750/${kw}?lock=${lock}`
  });
}

seedPhoto('Nature','First Light, Cascade Ridge', 11);
seedPhoto('Nature','Fern Understory', 12);
seedPhoto('Nature','Tidal Pool Study', 13);
seedPhoto('Nature','Alpine Treeline', 14);
seedPhoto('Nature','Meadow Grass, Wind', 15);

seedPhoto('Architecture','Concrete Stairwell No.3', 21);
seedPhoto('Architecture','Glass Curtain, Noon', 22);
seedPhoto('Architecture','Brutalist Corridor', 23);
seedPhoto('Architecture','Arches, Repetition', 24);
seedPhoto('Architecture','Rooftop Geometry', 25);

seedPhoto('Portrait','Study in Half-Light', 31);
seedPhoto('Portrait','Workshop Hands', 32);
seedPhoto('Portrait','Threshold, Looking Back', 33);
seedPhoto('Portrait','Quiet Profile', 34);

seedPhoto('Street','Crosswalk, Rain', 41);
seedPhoto('Street','Market Alley, 6AM', 42);
seedPhoto('Street','Neon After Hours', 43);
seedPhoto('Street','Platform, Departure', 44);

seedPhoto('Abstract','Rust & Water Line', 51);
seedPhoto('Abstract','Shadow Fragment', 52);
seedPhoto('Abstract','Grain Study No.7', 53);
seedPhoto('Abstract','Folded Light', 54);

/* ---------------- State ---------------- */
let activeCat = 'All';
let customCategories = Object.keys(CATEGORY_KEYWORDS); // categories persist even with 0 photos

const catsEl = document.getElementById('cats');
const countEl = document.getElementById('count');
const galleryEl = document.getElementById('gallery');
const emptyState = document.getElementById('emptyState');

function categories(){
  return Array.from(new Set([...photos.map(p=>p.cat), ...customCategories])).sort();
}

function visibleList(){
  return photos.filter(p => activeCat === 'All' || p.cat === activeCat);
}

function renderCats(){
  const cats = ['All', ...categories()];
  catsEl.innerHTML = '';
  cats.forEach(cat=>{
    const btn = document.createElement('button');
    btn.className = 'cat-btn' + (cat===activeCat ? ' active' : '');
    if(cat !== 'All') btn.style.setProperty('--cat-dot', themeFor(cat));
    btn.textContent = cat;
    btn.addEventListener('click', ()=>{ activeCat = cat; renderCats(); renderGallery(); });
    catsEl.appendChild(btn);
  });

  const newCatBtn = document.createElement('button');
  newCatBtn.className = 'cat-btn cat-btn-new';
  newCatBtn.textContent = '+ New Category';
  newCatBtn.addEventListener('click', openCategoryModal);
  catsEl.appendChild(newCatBtn);
}

// Reused across renders so existing tiles (and their already-loaded
// <img> elements) are never thrown away just because the category
// filter changed or a photo was added/removed elsewhere in the list.
// This is what was making every click feel slow: innerHTML='' used to
// force every visible photo to be re-downloaded and re-decoded.
const frameElements = new Map(); // photo id -> frame DOM node
let addTileEl = null; // the persistent "+ Add Photos" tile

function createFrameNode(p){
  const frame = document.createElement('div');
  frame.className = 'frame';
  frame.dataset.id = p.id;
  // NOTE: removed the native `loading="lazy"` attribute below.
  // With native lazy-loading, the browser only starts fetching an
  // <img> once it's near the viewport. In this gallery that meant
  // everything past roughly the first 14 tiles (the point where the
  // grid runs past the fold) never got requested at all unless the
  // container was scrolled in a way that fired the browser's lazy
  // load trigger. Since this is a small, finite gallery (~20 photos),
  // eager loading is cheap and reliable; fetchpriority below still
  // keeps above-the-fold images prioritized on the network.
  frame.innerHTML = `
    <img alt="${p.cat} photo" decoding="async">
    <div class="frame-index">No. ${String(p.id+1).padStart(2,'0')}</div>
    <div class="frame-expand">⤢</div>
    <button class="frame-delete-btn" title="Delete photo" aria-label="Delete photo">🗑</button>
    <div class="frame-hover-nav">
      <div class="tile-nav-btn" data-dir="-1" title="Previous">‹</div>
      <div class="tile-nav-btn" data-dir="1" title="Next">›</div>
    </div>
    <div class="frame-cat-tag"><span class="dot"></span>${p.cat}</div>
  `;
  frame.addEventListener('click', (e)=>{
    const delBtn = e.target.closest('.frame-delete-btn');
    if(delBtn){
      e.stopPropagation();
      confirmAndDelete(p.id);
      return;
    }
    const navBtn = e.target.closest('.tile-nav-btn');
    if(navBtn){
      e.stopPropagation();
      stepTile(p.id, parseInt(navBtn.dataset.dir, 10));
      return;
    }
    openLightbox(p.id);
  });
  return frame;
}

function createAddTile(){
  const addTile = document.createElement('div');
  addTile.className = 'add-tile';
  addTile.innerHTML = `<div class="plus">+</div><span>Add Photos</span>`;
  addTile.addEventListener('click', openUploadModal);
  addTile.addEventListener('dragover', (e)=>{ e.preventDefault(); addTile.classList.add('dragover'); });
  addTile.addEventListener('dragleave', ()=> addTile.classList.remove('dragover'));
  addTile.addEventListener('drop', (e)=>{
    e.preventDefault();
    addTile.classList.remove('dragover');
    openUploadModal();
    queueFiles(e.dataTransfer.files);
  });
  return addTile;
}

function renderGallery(){
  const list = visibleList();

  // Always recompute the count fresh from the live photos array so the
  // number next to the Add button can never drift out of sync with
  // what's actually on screen.
  countEl.textContent = `${list.length} photo${list.length!==1?'s':''}`;
  emptyState.style.display = list.length === 0 ? 'block' : 'none';

  const keepIds = new Set(list.map(p=>p.id));

  // Drop tiles for photos that no longer exist / no longer match the filter
  for(const [id, node] of frameElements){
    if(!keepIds.has(id)){
      node.remove();
      frameElements.delete(id);
    }
  }

  // Create or update each visible tile, but only touch the <img src>
  // when it actually changes so the browser can serve already-decoded
  // images straight from cache instead of re-requesting them.
  list.forEach((p, i)=>{
    let frame = frameElements.get(p.id);
    if(!frame){
      frame = createFrameNode(p);
      frameElements.set(p.id, frame);
    }
    frame.style.setProperty('--cat-dot', themeFor(p.cat));

    const img = frame.querySelector('img');
    if(img.getAttribute('src') !== p.src){
      // first ~8 tiles are likely above the fold, so fetch them with
      // higher priority; everything else stays low-priority (but still
      // eagerly requested — see createFrameNode note above)
      img.setAttribute('fetchpriority', i < 8 ? 'high' : 'low');
      img.src = p.src;
    }
    // Self-healing fallback: if the primary image host ever 500s /
    // fails for this photo (as loremflickr did for some tag combos),
    // swap to a seeded picsum.photos image instead of leaving a blank
    // tile. data-fallback-applied prevents an infinite error loop if
    // the fallback itself fails.
    if(!img.dataset.fallbackBound){
      img.dataset.fallbackBound = '1';
      img.addEventListener('error', ()=>{
        if(img.dataset.fallbackApplied) return;
        img.dataset.fallbackApplied = '1';
        img.src = `https://picsum.photos/seed/gallery-${p.id}/500/625`;
      });
    }

    // keep DOM order in sync with the (possibly re-sorted/filtered) list,
    // moving a node only when it isn't already in the right spot
    const current = galleryEl.children[i];
    if(current !== frame) galleryEl.insertBefore(frame, current || null);
  });

  // add-photos tile is created once and always pinned to the end
  if(!addTileEl){
    addTileEl = createAddTile();
  }
  galleryEl.appendChild(addTileEl);
}

// hovering the prev/next arrow on a tile opens that neighbouring photo directly
function stepTile(id, dir){
  const ids = visibleList().map(p=>p.id);
  let pos = ids.indexOf(id);
  pos = (pos + dir + ids.length) % ids.length;
  openLightbox(ids[pos]);
}

/* ---------------- Delete ---------------- */
function confirmAndDelete(id){
  const p = photos.find(ph=>ph.id===id);
  if(!p) return;
  const ok = window.confirm(`Delete "${p.title}"? This cannot be undone.`);
  if(ok) deletePhoto(id);
}

function deletePhoto(id){
  const idx = photos.findIndex(p=>p.id===id);
  if(idx === -1) return;
  photos.splice(idx, 1);

  // if the lightbox is open on the photo being deleted, move to a
  // neighbour or close if nothing is left to show
  if(lightbox.classList.contains('open') && currentId === id){
    const remaining = visibleList();
    if(remaining.length === 0){
      closeLightbox();
    } else {
      currentId = remaining[0].id;
      renderLightbox();
    }
  }

  renderGallery();
}

/* ---------------- Uploading (modal) ---------------- */
const addBtn = document.getElementById('addBtn');
const fileInput = document.getElementById('fileInput');
const uploadModal = document.getElementById('uploadModal');
const dropzone = document.getElementById('dropzone');
const pendingGrid = document.getElementById('pendingGrid');
const modalCategorySelect = document.getElementById('modalCategorySelect');
const newCategoryInput = document.getElementById('newCategoryInput');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalCloseBtn = document.getElementById('modalCloseBtn');

let pendingFiles = []; // { file, dataUrl }

function readFileAsDataURL(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = ()=> reject(new Error('Could not read ' + file.name));
    reader.readAsDataURL(file);
  });
}

function refreshModalCategories(){
  const prevVal = modalCategorySelect.value;
  modalCategorySelect.innerHTML = '';
  categories().forEach(cat=>{
    const opt = document.createElement('option');
    opt.value = cat; opt.textContent = cat;
    modalCategorySelect.appendChild(opt);
  });
  const newOpt = document.createElement('option');
  newOpt.value = '__new__'; newOpt.textContent = '+ New category…';
  modalCategorySelect.appendChild(newOpt);
  if(categories().includes(prevVal)) modalCategorySelect.value = prevVal;
  else if(activeCat !== 'All' && categories().includes(activeCat)) modalCategorySelect.value = activeCat;
  newCategoryInput.style.display = modalCategorySelect.value === '__new__' ? 'block' : 'none';
}

function openUploadModal(){
  pendingFiles = [];
  renderPendingGrid();
  refreshModalCategories();
  uploadModal.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeUploadModal(){
  uploadModal.classList.remove('open');
  document.body.style.overflow = '';
  pendingFiles = [];
  fileInput.value = '';
}

async function queueFiles(fileList){
  const files = Array.from(fileList || []).filter(f=> f.type.startsWith('image/'));
  for(const file of files){
    try{
      const dataUrl = await readFileAsDataURL(file);
      pendingFiles.push({ file, dataUrl });
    }catch(err){ console.error(err); }
  }
  renderPendingGrid();
}

function renderPendingGrid(){
  pendingGrid.innerHTML = '';
  pendingFiles.forEach((pf, idx)=>{
    const item = document.createElement('div');
    item.className = 'pending-item';
    item.innerHTML = `
      <img src="${pf.dataUrl}" alt="${pf.file.name}">
      <button class="pending-remove" title="Remove">✕</button>
      <div class="pending-name">${pf.file.name}</div>
    `;
    item.querySelector('.pending-remove').addEventListener('click', ()=>{
      pendingFiles.splice(idx, 1);
      renderPendingGrid();
    });
    pendingGrid.appendChild(item);
  });
  modalConfirmBtn.disabled = pendingFiles.length === 0;
  modalConfirmBtn.textContent = pendingFiles.length > 0
    ? `Add ${pendingFiles.length} Photo${pendingFiles.length>1?'s':''}`
    : 'Add Photos';
}

addBtn.addEventListener('click', openUploadModal);
modalCloseBtn.addEventListener('click', closeUploadModal);
modalCancelBtn.addEventListener('click', closeUploadModal);
uploadModal.addEventListener('click', (e)=>{ if(e.target === uploadModal) closeUploadModal(); });

dropzone.addEventListener('click', ()=> fileInput.click());
fileInput.addEventListener('change', ()=>{ queueFiles(fileInput.files); fileInput.value=''; });
dropzone.addEventListener('dragover', (e)=>{ e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', ()=> dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e)=>{
  e.preventDefault();
  dropzone.classList.remove('dragover');
  queueFiles(e.dataTransfer.files);
});

modalCategorySelect.addEventListener('change', ()=>{
  newCategoryInput.style.display = modalCategorySelect.value === '__new__' ? 'block' : 'none';
  if(modalCategorySelect.value === '__new__') newCategoryInput.focus();
});

modalConfirmBtn.addEventListener('click', ()=>{
  if(pendingFiles.length === 0) return;

  let cat = modalCategorySelect.value;
  if(cat === '__new__'){
    cat = newCategoryInput.value.trim() || 'Uncategorized';
    if(!customCategories.some(c=> c.toLowerCase() === cat.toLowerCase())) customCategories.push(cat);
  }

  pendingFiles.forEach((pf)=>{
    const rawName = pf.file.name.replace(/\.[^/.]+$/, '');
    const title = rawName.replace(/[-_]+/g,' ').replace(/\b\w/g, c=>c.toUpperCase()) || 'Untitled';
    const id = nextId++;
    photos.push({ id, cat, title, src: pf.dataUrl, full: pf.dataUrl });
  });

  activeCat = cat;
  renderCats();
  renderGallery();
  closeUploadModal();
});

/* ---------------- New Category modal ---------------- */
const categoryModal = document.getElementById('categoryModal');
const categoryNameInput = document.getElementById('categoryNameInput');
const categoryError = document.getElementById('categoryError');
const categoryConfirmBtn = document.getElementById('categoryConfirmBtn');
const categoryCancelBtn = document.getElementById('categoryCancelBtn');
const categoryModalCloseBtn = document.getElementById('categoryModalCloseBtn');

function openCategoryModal(){
  categoryNameInput.value = '';
  categoryError.style.display = 'none';
  categoryModal.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(()=> categoryNameInput.focus(), 50);
}
function closeCategoryModal(){
  categoryModal.classList.remove('open');
  document.body.style.overflow = '';
}
function showCategoryError(msg){
  categoryError.textContent = msg;
  categoryError.style.display = 'block';
}

function submitNewCategory(){
  const name = categoryNameInput.value.trim();
  if(!name){ showCategoryError('Give the category a name.'); return; }
  const exists = categories().some(c=> c.toLowerCase() === name.toLowerCase());
  if(exists){ showCategoryError('That category already exists.'); return; }
  customCategories.push(name);
  activeCat = name;
  renderCats();
  renderGallery();
  closeCategoryModal();
}

categoryConfirmBtn.addEventListener('click', submitNewCategory);
categoryCancelBtn.addEventListener('click', closeCategoryModal);
categoryModalCloseBtn.addEventListener('click', closeCategoryModal);
categoryModal.addEventListener('click', (e)=>{ if(e.target === categoryModal) closeCategoryModal(); });
categoryNameInput.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') submitNewCategory(); });

/* ---------------- Lightbox ---------------- */
const lightbox = document.getElementById('lightbox');
const lbImg = document.getElementById('lbImg');
const lbImgWrap = document.getElementById('lbImgWrap');
const lbTitle = document.getElementById('lbTitle');
const lbCat = document.getElementById('lbCat');
const lbIndexLabel = document.getElementById('lbIndexLabel');
const lbCounter = document.getElementById('lbCounter');
const zoomLevel = document.getElementById('zoomLevel');
const lbFilters = document.getElementById('lbFilters');
const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');

const FILTER_PRESETS = [
  { key:'original', label:'Original', css:'none' },
  { key:'bw',        label:'B&W',      css:'grayscale(1)' },
  { key:'sepia',     label:'Sepia',    css:'sepia(0.7) contrast(1.05)' },
  { key:'vintage',   label:'Vintage',  css:'sepia(0.35) contrast(1.1) brightness(1.05) saturate(1.3)' },
  { key:'cool',      label:'Cool',     css:'hue-rotate(180deg) saturate(1.15)' },
  { key:'warm',      label:'Warm',     css:'sepia(0.2) saturate(1.35) hue-rotate(-8deg)' },
  { key:'vivid',     label:'Vivid',    css:'saturate(1.6) contrast(1.1)' },
  { key:'fade',      label:'Fade',     css:'contrast(0.85) brightness(1.1) saturate(0.7)' },
];

FILTER_PRESETS.forEach(f=>{
  const chip = document.createElement('button');
  chip.className = 'lb-filter-chip' + (f.key==='original' ? ' active' : '');
  chip.textContent = f.label;
  chip.dataset.key = f.key;
  chip.addEventListener('click', ()=>{
    lbImg.style.filter = f.css;
    document.querySelectorAll('.lb-filter-chip').forEach(c=> c.classList.toggle('active', c.dataset.key===f.key));
  });
  lbFilters.appendChild(chip);
});

// delete button injected into the lightbox toolbar, right next to the
// close button, so a photo can be removed while viewing it full-size
const lbCloseBtn = document.getElementById('lbClose');
const lbDeleteBtn = document.createElement('button');
lbDeleteBtn.id = 'lbDeleteBtn';
lbDeleteBtn.className = 'lb-delete-btn';
lbDeleteBtn.title = 'Delete photo';
lbDeleteBtn.setAttribute('aria-label', 'Delete photo');
lbDeleteBtn.textContent = '🗑';
lbDeleteBtn.addEventListener('click', ()=> confirmAndDelete(currentId));
if(lbCloseBtn && lbCloseBtn.parentElement){
  lbCloseBtn.parentElement.insertBefore(lbDeleteBtn, lbCloseBtn);
}

let currentId = 0;
let zoom = 1;
const ZOOM_MIN = 1, ZOOM_MAX = 3, ZOOM_STEP = 0.25;

function openLightbox(id){
  currentId = id;
  renderLightbox();
  lightbox.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeLightbox(){
  lightbox.classList.remove('open');
  document.body.style.overflow = '';
}
function renderLightbox(){
  const p = photos.find(ph=>ph.id === currentId);
  if(!p){ closeLightbox(); return; }
  setZoom(1);
  lbImg.style.filter = 'none';
  document.querySelectorAll('.lb-filter-chip').forEach(c=> c.classList.toggle('active', c.dataset.key==='original'));
  lightbox.style.setProperty('--lb-accent', themeFor(p.cat));
  delete lbImg.dataset.fallbackApplied;
  lbImg.onerror = ()=>{
    if(lbImg.dataset.fallbackApplied) return;
    lbImg.dataset.fallbackApplied = '1';
    lbImg.src = `https://picsum.photos/seed/gallery-${p.id}/1400/1750`;
  };
  lbImg.src = p.full;
  lbImg.alt = p.title;
  lbTitle.textContent = p.title;
  lbCat.textContent = p.cat;
  lbIndexLabel.textContent = `No. ${String(p.id+1).padStart(2,'0')}`;

  const ids = visibleList().map(ph=>ph.id);
  const pos = ids.indexOf(currentId);
  lbCounter.textContent = `${pos+1} / ${ids.length}`;
}
function step(dir){
  const ids = visibleList().map(p=>p.id);
  let pos = ids.indexOf(currentId);
  if(pos === -1) pos = 0;
  pos = (pos + dir + ids.length) % ids.length;
  currentId = ids[pos];
  renderLightbox();
}
function setZoom(z){
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  lbImg.style.transform = `scale(${zoom})`;
  zoomLevel.textContent = Math.round(zoom*100)+'%';
  lbImg.style.cursor = zoom > 1 ? 'grab' : 'zoom-in';
  zoomInBtn.disabled = zoom >= ZOOM_MAX;
  zoomOutBtn.disabled = zoom <= ZOOM_MIN;
}

document.getElementById('lbClose').addEventListener('click', closeLightbox);
document.getElementById('lbPrev').addEventListener('click', ()=> step(-1));
document.getElementById('lbNext').addEventListener('click', ()=> step(1));
zoomInBtn.addEventListener('click', ()=> setZoom(zoom + ZOOM_STEP));
zoomOutBtn.addEventListener('click', ()=> setZoom(zoom - ZOOM_STEP));
document.getElementById('zoomReset').addEventListener('click', ()=> setZoom(1));

lightbox.addEventListener('click', (e)=>{ if(e.target === lightbox) closeLightbox(); });
lbImg.addEventListener('dblclick', ()=> setZoom(zoom > 1 ? 1 : 2));
lbImg.addEventListener('click', (e)=>{ e.stopPropagation(); if(zoom<=1) setZoom(2); });

let isDown=false, startX=0, startY=0, scrollLeft=0, scrollTop=0;
lbImgWrap.addEventListener('mousedown',(e)=>{
  if(zoom<=1) return;
  isDown=true; lbImg.style.cursor='grabbing';
  startX = e.pageX; startY = e.pageY;
  scrollLeft = lbImgWrap.scrollLeft; scrollTop = lbImgWrap.scrollTop;
});
window.addEventListener('mouseup', ()=>{ isDown=false; lbImg.style.cursor = zoom>1 ? 'grab':'zoom-in'; });
window.addEventListener('mousemove',(e)=>{
  if(!isDown) return;
  lbImgWrap.scrollLeft = scrollLeft - (e.pageX - startX);
  lbImgWrap.scrollTop = scrollTop - (e.pageY - startY);
});

document.addEventListener('keydown', (e)=>{
  if(categoryModal.classList.contains('open') && e.key === 'Escape'){ closeCategoryModal(); return; }
  if(uploadModal.classList.contains('open') && e.key === 'Escape'){ closeUploadModal(); return; }
  if(!lightbox.classList.contains('open')) return;
  if(e.key === 'Escape') closeLightbox();
  if(e.key === 'ArrowLeft') step(-1);
  if(e.key === 'ArrowRight') step(1);
  if(e.key === '+' || e.key === '=') setZoom(zoom + ZOOM_STEP);
  if(e.key === '-') setZoom(zoom - ZOOM_STEP);
  if(e.key === 'Delete' || e.key === 'Backspace') confirmAndDelete(currentId);
});

let touchStartX = 0;
lbImgWrap.addEventListener('touchstart', (e)=>{ touchStartX = e.changedTouches[0].screenX; }, {passive:true});
lbImgWrap.addEventListener('touchend', (e)=>{
  const dx = e.changedTouches[0].screenX - touchStartX;
  if(Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
}, {passive:true});

/* ---------------- Delete feature styles ----------------
   Self-contained CSS injected here so the delete buttons work even
   without touching the external stylesheet. Safe to move into your
   main CSS file and delete this block if you prefer. */
(function injectDeleteStyles(){
  const style = document.createElement('style');
  style.textContent = `
    .frame-delete-btn{
      position:absolute;
      top:10px;
      left:10px;
      width:32px;
      height:32px;
      border:none;
      border-radius:50%;
      background:rgba(20,20,20,0.55);
      color:#fff;
      font-size:14px;
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      opacity:0;
      transform:translateY(-4px);
      transition:opacity 0.15s ease, transform 0.15s ease, background 0.15s ease;
      z-index:3;
    }
    .frame:hover .frame-delete-btn{
      opacity:1;
      transform:translateY(0);
    }
    .frame-delete-btn:hover{
      background:#c14b4b;
    }
    .lb-delete-btn{
      width:38px;
      height:38px;
      border:none;
      border-radius:50%;
      background:rgba(255,255,255,0.08);
      color:#fff;
      font-size:16px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      margin-right:8px;
      transition:background 0.15s ease;
    }
    .lb-delete-btn:hover{
      background:#c14b4b;
    }
  `;
  document.head.appendChild(style);
})();

/* ---------------- Perf: warm up the image host connection ---------------- */
(function preconnectImageHost(){
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = 'https://loremflickr.com';
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
})();

/* ---------------- Init ---------------- */
renderCats();
renderGallery();