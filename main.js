import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { Sky } from 'three/addons/objects/Sky.js';

try {
    // --- 1. CONFIGURACIÓN Y DATOS ---
    const ENV_COLORS = { white: 0xffffff, green: 0x2ecc71, blue: 0x3498db, yellow: 0xf1c40f };
    const FLOOR_COLORS = { garnet: 0xA04040, blue: 0x2980b9, green: 0x27ae60, black: 0x2c3e50 };
    const PRICE_PER_M2 = 40; 
    const LOGO_URL = "logo.png"; 
    const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRBy55ReQjx0odJ_aagHh_fjWNr-y97kPoT2stB6axgSvGZV0LLrc9n4EVysCxU4tpweWDVGld0SrAJ/pub?output=csv"; 

    let productsDB = {}; 

    // --- 2. VARIABLES GLOBALES ---
    let scene, renderer, controls, perspectiveCamera, orthoCamera, activeCamera, raycaster, pointer = new THREE.Vector2();
    let transformControl; 
    let dirLight, hemiLight, sunAzimuth = 180, sunElevation = 30;
    let sky, sun;

    let productToPlace = null, productPrice = 0, selectedObject = null, totalPrice = 0;
    let pendingModelBase64 = null; 
    let isColliding = false;
    let isMeasuring = false, measurePoints = [], measureMarkers = [], measureLine = null, measureLabel = null;
    let isDrawingFloor = false, floorPoints = [], floorMarkers = [], floorLine = null, floorLabel = null, isInputFocused = false;

    const objectsInScene = [], loader = new GLTFLoader();
    let selectionBox, loadedLogoBase64 = null, loadedLogoImg = null;
    let shadowPlane;

    // --- 3. INICIALIZACIÓN ---
    init();

    async function init() {
        scene = new THREE.Scene();

        perspectiveCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
        perspectiveCamera.position.set(10, 10, 10);
        
        const aspect = window.innerWidth / window.innerHeight;
        const d = 20;
        orthoCamera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
        orthoCamera.position.set(20, 20, 20);
        activeCamera = perspectiveCamera;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap; 
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping; 
        renderer.toneMappingExposure = 0.5;
        renderer.xr.enabled = true;
        
        document.body.appendChild(renderer.domElement);
        
        // --- AR SETUP CORREGIDO PARA IOS ---
        const arBtn = ARButton.createButton(renderer, { 
            requiredFeatures: ['hit-test'], 
            optionalFeatures: ['dom-overlay'], 
            domOverlay: { root: document.body } 
        });
        document.body.appendChild(arBtn);

        // Eventos para arreglar la cámara tapada en AR
        renderer.xr.addEventListener('sessionstart', () => {
            // 1. Fondo CSS transparente para ver la cámara
            document.body.style.background = 'transparent'; 
            // 2. Ocultar la esfera del cielo para no tapar la realidad
            if(sky) sky.visible = false; 
            // 3. Quitar background de ThreeJS
            scene.background = null; 
        });

        renderer.xr.addEventListener('sessionend', () => {
            // Restaurar estilo original
            document.body.style.background = '#222'; 
            if(sky) {
                sky.visible = true;
                updateSunPosition(); // Restaurar ambiente
            }
        });
        // -----------------------------------

        // LUCES
        hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.6); 
        scene.add(hemiLight);
        
        dirLight = new THREE.DirectionalLight(0xffffff, 3); 
        dirLight.castShadow = true;
        
        // FIX SOMBRAS CORTADAS
        const shadowSize = 100; 
        dirLight.shadow.camera.left = -shadowSize;
        dirLight.shadow.camera.right = shadowSize;
        dirLight.shadow.camera.top = shadowSize;
        dirLight.shadow.camera.bottom = -shadowSize;
        dirLight.shadow.camera.far = 500; 
        dirLight.shadow.mapSize.width = 4096;
        dirLight.shadow.mapSize.height = 4096;
        dirLight.shadow.bias = -0.0001;
        scene.add(dirLight);

        // SUELO (Solo sombra)
        const shadowGeo = new THREE.PlaneGeometry(500, 500);
        const shadowMat = new THREE.ShadowMaterial({ opacity: 0.3, color: 0x000000 });
        shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
        shadowPlane.rotation.x = -Math.PI / 2;
        shadowPlane.position.y = 0.001; 
        shadowPlane.receiveShadow = true;
        scene.add(shadowPlane);

        // SELECCIÓN Y GIZMO
        selectionBox = new THREE.BoxHelper(undefined, 0xffff00);
        scene.add(selectionBox);
        selectionBox.visible = false;

        controls = new OrbitControls(activeCamera, renderer.domElement);
        controls.enableDamping = true; 
        raycaster = new THREE.Raycaster();

        transformControl = new TransformControls(activeCamera, renderer.domElement);
        transformControl.setTranslationSnap(0.1); 
        transformControl.setRotationSnap(THREE.MathUtils.degToRad(15)); 
        transformControl.addEventListener('dragging-changed', function (event) { controls.enabled = !event.value; });
        transformControl.addEventListener('change', function () { if (selectedObject) { selectionBox.update(); checkCollisions(); } });
        scene.add(transformControl);

        // CIELO
        initSky();

        window.addEventListener('resize', onWindowResize);

        await loadSheetData();
        setupEventListeners();
        setupUploadSystem();
        preloadLogo();

        renderer.setAnimationLoop(render);
    }

    function initSky() {
        sky = new Sky();
        sky.scale.setScalar(450000);
        scene.add(sky);
        sun = new THREE.Vector3();

        const uniforms = sky.material.uniforms;
        uniforms['turbidity'].value = 10;
        uniforms['rayleigh'].value = 2;
        uniforms['mieCoefficient'].value = 0.005;
        uniforms['mieDirectionalG'].value = 0.8;

        updateSunPosition();
    }

    function updateSunPosition() {
        const phi = THREE.MathUtils.degToRad(90 - sunElevation);
        const theta = THREE.MathUtils.degToRad(sunAzimuth);
        sun.setFromSphericalCoords(1, phi, theta);
        sky.material.uniforms['sunPosition'].value.copy(sun);
        dirLight.position.setFromSphericalCoords(100, phi, theta);

        if (renderer && sky.visible) {
            const pmremGenerator = new THREE.PMREMGenerator(renderer);
            scene.environment = pmremGenerator.fromScene(sky).texture;
        }
    }

    // --- CARGA DE DATOS ---
    async function loadSheetData() {
        if (!SHEET_URL) return;
        try {
            const response = await fetch(SHEET_URL);
            if (!response.ok) throw new Error("Error conectando con Google Sheets");
            const csvText = await response.text();
            productsDB = parseCSVtoTree(csvText);
            initCatalogUI();
        } catch (error) { console.error("Error Sheet:", error); }
    }

    function parseCSVtoTree(csv) {
        const rows = csv.split('\n').map(row => row.trim()).filter(row => row.length > 0);
        const headers = rows[0].split(',').map(h => h.trim().toUpperCase());
        const db = {};
        for (let i = 1; i < rows.length; i++) {
            const values = rows[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            const item = {};
            headers.forEach((header, index) => {
                let val = values[index] ? values[index].trim() : "";
                val = val.replace(/^"|"$/g, '');
                item[header] = val;
            });
            const linea = item['LINEA'] || "Sin Línea";
            const cat = item['CATEGORIA'] || "Varios";
            const productObj = {
                name: item['NOMBRE'], file: item['ARCHIVO_GLB'], price: parseFloat(item['PRECIO']) || 0,
                ref: item['REF'] || "", desc: item['DESC'] || "", dims: item['DIMS'] || "",
                url_tech: item['URL_TECH'] || "#", url_cert: item['URL_CERT'] || "#", url_inst: item['URL_INST'] || "#", img_2d: item['IMG_2D'] || ""
            };
            if (!db[linea]) db[linea] = {};
            if (!db[linea][cat]) db[linea][cat] = [];
            db[linea][cat].push(productObj);
        }
        return db;
    }

    function initCatalogUI() {
        const select = document.getElementById('line-select');
        if (!select) return;
        select.innerHTML = "";
        const lines = Object.keys(productsDB);
        if (lines.length === 0) return;
        lines.forEach(l => { const o = document.createElement('option'); o.value = l; o.innerText = l; select.appendChild(o); });
        select.addEventListener('change', (e) => renderCategories(e.target.value));
        renderCategories(lines[0]);
    }

    // --- UPLOAD SYSTEM ---
    function setupUploadSystem() {
        const btn = document.getElementById('btn-upload-trigger');
        const input = document.getElementById('file-upload');
        if(!btn || !input) return;
        btn.addEventListener('click', () => input.click());
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const name = file.name.toLowerCase();
            if (name.endsWith('.glb') || name.endsWith('.gltf')) {
                const reader = new FileReader(); reader.readAsDataURL(file);
                reader.onload = function(evt) { prepareImportedModel(URL.createObjectURL(file), file.name, evt.target.result); };
            } else if (name.endsWith('.jpg') || name.endsWith('.png') || name.endsWith('.jpeg')) {
                const url = URL.createObjectURL(file);
                if (selectedObject && selectedObject.userData.isFloor) applyTextureToSelectedFloor(url, file.name);
                else prepareCustomFloor(url, file.name);
            } else { alert("Formato no soportado."); }
            input.value = ""; 
        });
    }

    function prepareImportedModel(url, filename, base64Data) {
        if (isMeasuring) toggleMeasureMode(); if (isDrawingFloor) toggleFloorMode(); deselectObject();
        const userRef = prompt("Referencia:", "CUSTOM") || "CUSTOM";
        const userName = prompt("Nombre:", filename) || filename;
        const userPrice = parseFloat(prompt("Precio (€):", "0")) || 0;
        window.currentProductData = { name: userName, price: userPrice, ref: userRef, desc: "Importado", dims: "Custom" };
        productToPlace = url; productPrice = userPrice; pendingModelBase64 = base64Data;
        alert("Haz click en el suelo para colocar.");
    }

    function applyTextureToSelectedFloor(url, filename) {
        const floor = selectedObject; const oldPrice = floor.userData.price || 0;
        const priceM2 = parseFloat(prompt("Precio m2 (€):", "0")) || 0;
        new THREE.TextureLoader().load(url, (t) => {
            t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(0.5, 0.5);
            floor.material.map = t; floor.material.color.setHex(0xffffff); floor.material.needsUpdate = true;
            const area = parseFloat(floor.userData.area); const newPrice = Math.round(area * priceM2);
            totalPrice += (newPrice - oldPrice); updateBudget();
            floor.userData.price = newPrice; floor.userData.name = "Suelo: " + filename; floor.userData.img_2d = url;
            document.getElementById('floor-price-display').innerText = newPrice;
            updateFloorInfoLabel(`Area: ${area}m² (${newPrice}€)`, floor.position);
        });
    }

    function prepareCustomFloor(url, filename) {
        const width = parseFloat(prompt("Ancho real (m):", "10")); if(isNaN(width)) return;
        const priceM2 = parseFloat(prompt("Precio m2 (€):", "0")) || 0;
        new THREE.TextureLoader().load(url, (t) => {
            t.colorSpace = THREE.SRGBColorSpace; const asp = t.image.height / t.image.width; const height = width * asp; const area = width * height; const pr = Math.round(area * priceM2);
            const m = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ map: t, transparent:false, opacity:1 }));
            m.rotation.x = -Math.PI/2; m.position.y = 0.05; m.receiveShadow = true;
            m.userData = { price: pr, locked:false, collides:true, isFloor:true, name: "Suelo: "+filename, ref:"IMG", dims:`${width}x${height.toFixed(2)}`, area:area.toFixed(2), img_2d:url };
            scene.add(m); objectsInScene.push(m); totalPrice += pr; updateBudget(); selectObject(m);
        });
    }

    // --- PERSISTENCIA ---
    function saveProject() {
        const d = { date: new Date().toISOString(), totalPrice: totalPrice, items: [] };
        objectsInScene.forEach(obj => { d.items.push({ type: obj.userData.isFloor?'floor':'model', pos: obj.position, rot: obj.rotation, data: obj.userData }); });
        const a = document.createElement('a'); a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(d)); a.download = "proyecto.json"; a.click();
    }
    function loadProject(e) {
        const f = e.target.files[0]; if(!f) return;
        const r = new FileReader(); r.onload = (ev) => {
            try { const j = JSON.parse(ev.target.result); resetScene(); j.items.forEach(i => i.type==='floor'?reconstructFloor(i):reconstructModel(i)); } catch(x){ alert("Error archivo"); }
        }; r.readAsText(f); e.target.value='';
    }
    function reconstructFloor(i) {
        if(!i.data.points) return; const pts = i.data.points.map(p=>new THREE.Vector3(p.x,p.y,p.z));
        const s = new THREE.Shape(); s.moveTo(pts[0].x, pts[0].z); for(let k=1;k<pts.length;k++) s.lineTo(pts[k].x, pts[k].z); s.lineTo(pts[0].x, pts[0].z);
        const m = new THREE.Mesh(new THREE.ExtrudeGeometry(s,{depth:0.05, bevelEnabled:false}), new THREE.MeshStandardMaterial({color:FLOOR_COLORS.garnet, roughness:0.9}));
        m.rotation.set(i.rot._x, i.rot._y, i.rot._z); m.position.set(i.pos.x, i.pos.y, i.pos.z); m.userData = i.data; m.receiveShadow=true; m.castShadow=true;
        scene.add(m); objectsInScene.push(m); totalPrice += (m.userData.price||0); updateBudget();
        updateFloorInfoLabel(`Area: ${m.userData.area}m²`, pts[pts.length-1]); setTimeout(()=>scene.remove(floorLabel),3000);
    }
    function reconstructModel(i) {
        let u = i.data.modelBase64 || i.data.modelFile; if(!u || u.startsWith('blob:')) return;
        loader.load(u, (g)=>{
            const m=g.scene; m.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
            m.position.set(i.pos.x, i.pos.y, i.pos.z); m.rotation.set(i.rot._x, i.rot._y, i.rot._z); m.userData = i.data;
            scene.add(m); objectsInScene.push(m); totalPrice += (i.data.price||0); updateBudget();
        });
    }

    // --- EVENTOS ---
    function setupEventListeners() {
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', ()=>{});
        window.addEventListener('keydown', onKeyDown);

        document.getElementById('btn-toggle-menu').addEventListener('click', () => toggleDisplay('ui-panel'));
        document.getElementById('btn-close-menu').addEventListener('click', () => document.getElementById('ui-panel').style.display = 'none');
        document.getElementById('btn-toggle-env').addEventListener('click', () => toggleDisplay('env-panel'));
        document.getElementById('btn-min-edit').addEventListener('click', () => toggleDisplay('edit-content'));

        document.querySelectorAll('.input-box').forEach(i => { i.addEventListener('focus', ()=>isInputFocused=true); i.addEventListener('blur', ()=>isInputFocused=false); i.addEventListener('input', updateFloorFromInput); });
        
        document.getElementById('env-white').addEventListener('click', () => setWhiteEnvironment());
        document.getElementById('env-morning').addEventListener('click', () => setSunPreset(90, 10, 0.8));
        document.getElementById('env-noon').addEventListener('click', () => setSunPreset(180, 80, 1.2));
        document.getElementById('env-evening').addEventListener('click', () => setSunPreset(270, 5, 0.8));

        document.getElementById('sun-azimuth').addEventListener('input', (e) => { sunAzimuth=e.target.value; updateSunPosition(); });
        document.getElementById('sun-elevation').addEventListener('input', (e) => { sunElevation=e.target.value; updateSunPosition(); });
        document.getElementById('light-intensity').addEventListener('input', (e) => { dirLight.intensity = parseFloat(e.target.value); });

        document.getElementById('btn-screenshot').addEventListener('click', takeScreenshot);
        document.getElementById('btn-export-pdf').addEventListener('click', generateDossier);
        document.getElementById('btn-projection').addEventListener('click', toggleProjection);
        document.getElementById('btn-save-project').addEventListener('click', saveProject);
        document.getElementById('btn-load-project').addEventListener('click', () => document.getElementById('project-upload').click());
        document.getElementById('project-upload').addEventListener('change', loadProject);

        document.getElementById('view-iso').addEventListener('click', ()=>setView('iso')); document.getElementById('view-top').addEventListener('click', ()=>setView('top'));
        document.getElementById('view-front').addEventListener('click', ()=>setView('front')); document.getElementById('view-side').addEventListener('click', ()=>setView('side'));

        document.getElementById('btn-measure').addEventListener('click', toggleMeasureMode); document.getElementById('btn-floor').addEventListener('click', toggleFloorMode);
        document.getElementById('btn-add-point').addEventListener('click', addPointFromInput); document.getElementById('btn-close-floor').addEventListener('click', ()=>{finishFloor();toggleFloorMode();});
        document.getElementById('clear-measures').addEventListener('click', clearMeasurements);

        document.getElementById('fc-garnet').addEventListener('click', ()=>setFloorColor(FLOOR_COLORS.garnet)); document.getElementById('fc-blue').addEventListener('click', ()=>setFloorColor(FLOOR_COLORS.blue));
        document.getElementById('fc-green').addEventListener('click', ()=>setFloorColor(FLOOR_COLORS.green)); document.getElementById('fc-black').addEventListener('click', ()=>setFloorColor(FLOOR_COLORS.black));
        
        document.getElementById('btn-reset').addEventListener('click', resetScene); document.getElementById('btn-lock').addEventListener('click', toggleLock);
        document.getElementById('btn-collision').addEventListener('click', toggleObjectCollision); document.getElementById('btn-delete').addEventListener('click', deleteSelected);

        document.getElementById('mode-translate').addEventListener('click', ()=>setGizmoMode('translate')); document.getElementById('mode-rotate').addEventListener('click', ()=>setGizmoMode('rotate'));
    }

    function setWhiteEnvironment() { sky.visible = false; scene.background = new THREE.Color(0xffffff); scene.environment = null; }
    function setSunPreset(az, el, int) { sky.visible = true; scene.background = null; sunAzimuth = az; sunElevation = el; dirLight.intensity = int; document.getElementById('sun-azimuth').value = az; document.getElementById('sun-elevation').value = el; document.getElementById('light-intensity').value = int; updateSunPosition(); }

    function onPointerDown(event) {
        if (event.target.closest('#ui-panel') || event.target.closest('#edit-panel') || event.target.closest('#env-panel') || event.target.closest('#floor-input-panel') || event.target.closest('#action-panel')) return;
        if (transformControl.axis) return;
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1; pointer.y = - (event.clientY / window.innerHeight) * 2 + 1; raycaster.setFromCamera(pointer, activeCamera); 

        if (isDrawingFloor) { const i = raycaster.intersectObject(shadowPlane); if (i.length>0) addFloorPoint(i[0].point); return; }
        if (isMeasuring) { const i = raycaster.intersectObjects([...objectsInScene, shadowPlane], true); if(i.length>0) { if(measurePoints.length===2) clearMeasurements(); measurePoints.push(i[0].point); createMeasureMarker(i[0].point); if(measurePoints.length===2) updateMeasureLine(i[0].point); } return; }
        if (productToPlace) { const i = raycaster.intersectObject(shadowPlane); if (i.length>0) placeObject(i[0].point); return; }

        const i = raycaster.intersectObjects(objectsInScene, true);
        if (i.length > 0) { let s = i[0].object; while (s.parent && !objectsInScene.includes(s)) s = s.parent; if(objectsInScene.includes(s)) selectObject(s); }
        else deselectObject();
    }

    function onPointerMove(event) {
        if (isInputFocused) return;
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1; pointer.y = - (event.clientY / window.innerHeight) * 2 + 1; raycaster.setFromCamera(pointer, activeCamera);
        if (isDrawingFloor && floorPoints.length>0) { const i = raycaster.intersectObject(shadowPlane); if(i.length>0) updateFloorDraft(i[0].point); }
        if (isMeasuring && measurePoints.length===1) { const i = raycaster.intersectObjects([...objectsInScene, shadowPlane], true); if(i.length>0) updateMeasureLine(i[0].point); }
    }

    function onKeyDown(e) { if(e.key==='Delete') deleteSelected(); if(e.key==='t') setGizmoMode('translate'); if(e.key==='r') setGizmoMode('rotate'); }
    function setGizmoMode(m) { transformControl.setMode(m); const t=document.getElementById('mode-translate'), r=document.getElementById('mode-rotate'); if(m==='translate'){t.classList.add('active-mode');t.style.background='#4a90e2';t.style.color='white';r.classList.remove('active-mode');r.style.background='#444';r.style.color='#ccc';}else{r.classList.add('active-mode');r.style.background='#4a90e2';r.style.color='white';t.classList.remove('active-mode');t.style.background='#444';t.style.color='#ccc';} }
    
    // --- GESTIÓN ESCENA Y OBJETOS (RECUPERADO) ---
    function renderCategories(l) { 
        const c = document.getElementById('dynamic-catalog'); c.innerHTML=""; if(!productsDB[l]) return;
        for(const [cat, prods] of Object.entries(productsDB[l])) {
            const b=document.createElement('button'); b.className="accordion-btn"; b.innerText=cat;
            const p=document.createElement('div'); p.className="panel-products";
            prods.forEach(prod => { const bb=document.createElement('button'); bb.className="btn-product"; bb.innerHTML=`${prod.name} <span style="float:right;opacity:0.7">${prod.price}€</span>`; bb.onclick=()=>{prepareToPlace(prod,bb);if(window.innerWidth<600)document.getElementById('ui-panel').style.display='none'}; p.appendChild(bb); });
            b.onclick=()=>{b.classList.toggle("active-acc"); p.style.maxHeight=p.style.maxHeight?null:p.scrollHeight+"px"}; c.append(b,p);
        }
    }
    function prepareToPlace(d, b) { if(isMeasuring) toggleMeasureMode(); if(isDrawingFloor) toggleFloorMode(); deselectObject(); productToPlace=d.file; productPrice=d.price; window.currentProductData=d; pendingModelBase64=null; document.querySelectorAll('.btn-product').forEach(btn=>btn.classList.remove('active')); b.classList.add('active'); }
    function placeObject(p) { document.getElementById('loading').style.display='block'; const u=productToPlace; const b64=pendingModelBase64; loader.load(u, (g)=>{ const m=g.scene; m.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}}); m.position.set(p.x,0,p.z); m.userData=window.currentProductData; m.userData.modelFile=u; m.userData.modelBase64=b64; m.userData.locked=false; m.userData.collides=true; scene.add(m); objectsInScene.push(m); totalPrice+=m.userData.price; updateBudget(); selectObject(m); document.getElementById('loading').style.display='none'; productToPlace=null; pendingModelBase64=null; document.querySelectorAll('.btn-product').forEach(btn=>btn.classList.remove('active')); }); }

    function selectObject(o) { selectedObject=o; selectionBox.setFromObject(o); selectionBox.visible=true; if(!o.userData.locked) transformControl.attach(o); else transformControl.detach(); document.getElementById('edit-panel').style.display='block'; document.getElementById('edit-floor-specific').style.display=o.userData.isFloor?'block':'none'; if(o.userData.isFloor) document.getElementById('floor-price-display').innerText=o.userData.price||0; updateUI(); }
    function deselectObject() { selectedObject=null; selectionBox.visible=false; transformControl.detach(); document.getElementById('edit-panel').style.display='none'; }
    function updateUI() { if(!selectedObject) return; const l=document.getElementById('btn-lock'), c=document.getElementById('btn-collision'); if(selectedObject.userData.locked){l.innerText="🔒";l.classList.add('is-locked');selectionBox.material.color.setHex(0xff4444);transformControl.detach();}else{l.innerText="🔓";l.classList.remove('is-locked');selectionBox.material.color.setHex(0xffff00);if(transformControl.object!==selectedObject)transformControl.attach(selectedObject);} if(selectedObject.userData.collides){c.innerText="💥 ON";c.classList.remove('is-inactive');}else{c.innerText="👻 OFF";c.classList.add('is-inactive');} }
    function deleteSelected() { if(selectedObject&&!selectedObject.userData.locked){scene.remove(selectedObject);objectsInScene.splice(objectsInScene.indexOf(selectedObject),1);totalPrice-=selectedObject.userData.price||0;updateBudget();deselectObject();} }
    function resetScene() { objectsInScene.forEach(o=>scene.remove(o)); objectsInScene.length=0; totalPrice=0; updateBudget(); deselectObject(); clearMeasurements(); clearFloorDraft(); }
    function updateBudget() { document.getElementById('budget-box').innerText=totalPrice.toLocaleString('es-ES')+" €"; }
    function toggleLock() { if(selectedObject){selectedObject.userData.locked=!selectedObject.userData.locked;updateUI();} }
    function toggleObjectCollision() { if(selectedObject){selectedObject.userData.collides=!selectedObject.userData.collides;updateUI();} }
    function checkCollisions() { if(!selectedObject||!selectedObject.userData.collides){isColliding=false;return;} const b=new THREE.Box3().setFromObject(selectedObject).expandByScalar(-0.1); let h=false; for(let o of objectsInScene){if(o!==selectedObject&&o.userData.collides){if(b.intersectsBox(new THREE.Box3().setFromObject(o).expandByScalar(-0.1))){h=true;break;}}} isColliding=h; selectionBox.material.color.setHex(isColliding?0xffa500:0xffff00); if(!isColliding)updateUI(); }

    // --- HERRAMIENTAS ---
    function toggleMeasureMode() { if(isDrawingFloor) toggleFloorMode(); isMeasuring=!isMeasuring; const b=document.getElementById('btn-measure'); if(isMeasuring){b.classList.add('active-tool');b.innerText="📏 Click A";deselectObject();}else{b.classList.remove('active-tool');b.innerText="📏 Medir";clearMeasurements();} }
    function clearMeasurements() { measurePoints=[]; measureMarkers.forEach(m=>scene.remove(m)); measureMarkers=[]; if(measureLine)scene.remove(measureLine); if(measureLabel)scene.remove(measureLabel); document.getElementById('clear-measures').style.display='none'; }
    function createMeasureMarker(p) { const m=new THREE.Mesh(new THREE.SphereGeometry(0.15),new THREE.MeshBasicMaterial({color:0xe67e22,depthTest:false})); m.position.copy(p); m.renderOrder=999; scene.add(m); measureMarkers.push(m); }
    function updateMeasureLine(e) { if(measurePoints.length<1)return; const s=measurePoints[0]; if(measureLine)scene.remove(measureLine); const g=new THREE.BufferGeometry().setFromPoints([s,e]); measureLine=new THREE.Line(g,new THREE.LineBasicMaterial({color:0xe67e22,linewidth:3,depthTest:false})); measureLine.renderOrder=998; scene.add(measureLine); const d=s.distanceTo(e).toFixed(2); const b=document.getElementById('btn-measure'); if(isMeasuring&&measurePoints.length===1)b.innerText=`📏 ${d}m`; if(measurePoints.length===2){createMeasureLabel(d+" m", s.clone().lerp(e,0.5).add(new THREE.Vector3(0,0.3,0))); document.getElementById('clear-measures').style.display='block'; b.innerText="📏 Terminar";} }
    function createMeasureLabel(t,p) { if(measureLabel)scene.remove(measureLabel); const c=document.createElement('canvas');c.width=256;c.height=128;const x=c.getContext('2d');x.fillStyle="rgba(0,0,0,0.7)";x.roundRect(10,10,236,108,20);x.fill();x.font="bold 60px Arial";x.fillStyle="white";x.textAlign="center";x.textBaseline="middle";x.fillText(t,128,64);const s=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthTest:false}));s.position.copy(p);s.scale.set(2,1,1);s.renderOrder=999;scene.add(s);measureLabel=s; }
    
    function toggleFloorMode() { if(isMeasuring) toggleMeasureMode(); isDrawingFloor=!isDrawingFloor; const b=document.getElementById('btn-floor'),p=document.getElementById('floor-input-panel'); if(isDrawingFloor){b.classList.add('active-tool');b.innerText="✏️ Cancel";p.style.display='block';deselectObject();}else{b.classList.remove('active-tool');b.innerText="✏️ Suelo";p.style.display='none';clearFloorDraft();} }
    function clearFloorDraft() { floorPoints=[]; floorMarkers.forEach(m=>scene.remove(m)); floorMarkers=[]; if(floorLine)scene.remove(floorLine); if(floorLabel)scene.remove(floorLabel); document.getElementById('btn-close-floor').style.display='none'; document.getElementById('inp-dist').value=""; document.getElementById('inp-ang').value=""; }
    
    function updateFloorFromInput() {
        if (!isDrawingFloor || floorPoints.length === 0) return;
        const d = parseFloat(document.getElementById('inp-dist').value);
        const a = parseFloat(document.getElementById('inp-ang').value);
        if (!isNaN(d) && d > 0) {
            const last = floorPoints[floorPoints.length - 1];
            let dir = new THREE.Vector3(1, 0, 0);
            if (floorPoints.length >= 2) {
                const prev = floorPoints[floorPoints.length - 2];
                dir.subVectors(last, prev).normalize();
                if (!isNaN(a)) dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), a * (Math.PI / 180));
            }
            updateFloorDraft(last.clone().add(dir.multiplyScalar(d)), true);
        }
    }

    function updateFloorDraft(c, input=false) { if(floorPoints.length===0)return; if(floorLine)scene.remove(floorLine); const pts=[...floorPoints,c]; floorLine=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:0x9b59b6,linewidth:2})); scene.add(floorLine); const l=floorPoints[floorPoints.length-1],d=l.distanceTo(c).toFixed(2); let a=0; if(floorPoints.length>=2){const p=floorPoints[floorPoints.length-2];a=Math.round(new THREE.Vector3().subVectors(l,p).normalize().angleTo(new THREE.Vector3().subVectors(c,l).normalize())*(180/Math.PI));} if(!input&&!isInputFocused){document.getElementById('inp-dist').value=d;document.getElementById('inp-ang').value=a;} updateFloorInfoLabel(`${d}m`,c); if(floorPoints.length>=3)document.getElementById('btn-close-floor').style.display='block'; }
    function updateFloorInfoLabel(t,p) { if(floorLabel)scene.remove(floorLabel); const c=document.createElement('canvas');c.width=300;c.height=100;const x=c.getContext('2d');x.fillStyle="rgba(0,0,0,0.6)";x.roundRect(10,10,280,80,15);x.fill();x.font="bold 40px Arial";x.fillStyle="#fff";x.textAlign="center";x.textBaseline="middle";x.fillText(t,150,50);const m=new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthTest:false});floorLabel=new THREE.Sprite(m);floorLabel.position.copy(p).add(new THREE.Vector3(0,0.5,0));floorLabel.scale.set(3,1,1);floorLabel.renderOrder=999;scene.add(floorLabel); }
    function addPointFromInput() { if(isDrawingFloor){const d=parseFloat(document.getElementById('inp-dist').value),a=parseFloat(document.getElementById('inp-ang').value);if(!isNaN(d)&&d>0){const l=floorPoints.length>0?floorPoints[floorPoints.length-1]:new THREE.Vector3(0,0,0);let v=new THREE.Vector3(1,0,0);if(floorPoints.length>=2){const p=floorPoints[floorPoints.length-2];v.subVectors(l,p).normalize();if(!isNaN(a))v.applyAxisAngle(new THREE.Vector3(0,1,0),a*(Math.PI/180));}addFloorPoint(l.clone().add(v.multiplyScalar(d)));document.getElementById('inp-dist').value="";document.getElementById('inp-dist').focus();}else if(floorPoints.length===0)addFloorPoint(new THREE.Vector3(0,0,0));} }
    function addFloorPoint(p) { floorPoints.push(p); const m=new THREE.Mesh(new THREE.SphereGeometry(0.1,16,16),new THREE.MeshBasicMaterial({color:0x8e44ad}));m.position.copy(p);scene.add(m);floorMarkers.push(m); }
    function finishFloor() { if(floorPoints.length<3)return; let a=0;const n=floorPoints.length;for(let i=0;i<n;i++){const j=(i+1)%n;a+=floorPoints[i].x*floorPoints[j].z;a-=floorPoints[j].x*floorPoints[i].z;}a=Math.abs(a/2);const pr=Math.round(a*PRICE_PER_M2); const s=new THREE.Shape();s.moveTo(floorPoints[0].x,floorPoints[0].z);for(let i=1;i<floorPoints.length;i++)s.lineTo(floorPoints[i].x,floorPoints[i].z);s.lineTo(floorPoints[0].x,floorPoints[0].z); const m=new THREE.Mesh(new THREE.ExtrudeGeometry(s,{depth:0.05,bevelEnabled:false}),new THREE.MeshStandardMaterial({color:FLOOR_COLORS.garnet,roughness:0.9}));m.rotation.x=Math.PI/2;m.position.y=0.01;m.receiveShadow=true;m.castShadow=true; m.userData={price:pr,locked:false,collides:true,isFloor:true,area:a.toFixed(2),name:"Suelo Caucho",ref:"S-001",dims:`${a.toFixed(2)} m2`,points:floorPoints.map(p=>({x:p.x,y:p.y,z:p.z}))}; scene.add(m);objectsInScene.push(m);totalPrice+=pr;updateBudget();updateFloorInfoLabel(`Area: ${a.toFixed(2)}m²`,floorPoints[n-1]);setTimeout(()=>scene.remove(floorLabel),3000);clearFloorDraft(); }
    function setFloorColor(h) { if(selectedObject&&selectedObject.userData.isFloor)selectedObject.material.color.setHex(h); }

    // --- PDF & UTILS ---
    function preloadLogo() { const i=new Image();i.crossOrigin="Anonymous";i.src=LOGO_URL;i.onload=()=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;c.getContext('2d').drawImage(i,0,0);loadedLogoImg=i;loadedLogoBase64=c.toDataURL('image/png');};i.onerror=()=>{loadedLogoBase64=createLogoUrl();}; }
    function createLogoUrl() { const c=document.createElement('canvas');c.width=200;c.height=50;const x=c.getContext('2d');x.font="bold 40px Arial";x.fillStyle="#4a90e2";x.fillText("Levipark21",0,40);return c.toDataURL('image/png'); }
    function updateLoadingText(t) { document.getElementById('loading-text').innerText=t; }
    function wait(ms) { return new Promise(r=>setTimeout(r,ms)); }
    function fitImageToCanvas(c) { return { data: c.toDataURL('image/jpeg', 0.95), w: c.width, h: c.height }; }
    
    function fitImageInArea(imgW, imgH, maxW, maxH) { 
        const ratio = Math.min(maxW / imgW, maxH / imgH); 
        return { w: imgW * ratio, h: imgH * ratio }; 
    }
    
    function addHeader(d,r) { d.setFontSize(10);d.setTextColor(150);d.text(r,d.internal.pageSize.getWidth()-20,15,{align:'right'}); }
    function addFooter(d,dt,lg) { const w=d.internal.pageSize.getWidth(),h=d.internal.pageSize.getHeight();d.setFontSize(10);d.setTextColor(150);d.text(dt,20,h-15);if(lg){const r=loadedLogoImg?loadedLogoImg.width/loadedLogoImg.height:4;let lw=40,lh=lw/r;if(lh>15){lh=15;lw=lh*r;}d.addImage(lg,'PNG',w-10-lw,h-25,lw,lh);} }

    function toggleDisplay(id) { const e=document.getElementById(id);e.style.display=e.style.display==='none'?'block':'none'; }
    function takeScreenshot() { 
        transformControl.detach(); selectionBox.visible=false; 
        renderer.render(scene,activeCamera); 
        const d=renderer.domElement.toDataURL('image/jpeg',0.9); const a=document.createElement('a'); a.download='diseño.jpg'; a.href=d; a.click(); 
        if(selectedObject){selectionBox.visible=true;transformControl.attach(selectedObject);} 
    }
    
    // --- GENERADOR DE DOSSIER ---
    async function generateDossier() {
        const ref=prompt("Proyecto:","Nuevo Parque");if(!ref)return;
        const disc=parseFloat(prompt("Dto (%):","0"))||0;
        document.getElementById('loading').style.display='block';
        const doc=new window.jspdf.jsPDF(); const w=doc.internal.pageSize.getWidth(), h=doc.internal.pageSize.getHeight(), m=10;

        // 1. Preparar escena
        const prevSky = sky.visible; const prevBG = scene.background; const prevSel = selectionBox.visible;
        sky.visible = false; scene.background = new THREE.Color(0xffffff); selectionBox.visible = false; transformControl.detach();
        
        // 2. Portada
        updateLoadingText("Portada..."); await wait(100);
        const originalSize = new THREE.Vector2(); renderer.getSize(originalSize);
        renderer.setSize(2000, 1500); 
        activeCamera.aspect = 2000 / 1500; activeCamera.updateProjectionMatrix();
        renderer.render(scene,activeCamera); 
        const imgCov=renderer.domElement.toDataURL('image/jpeg',0.9);
        renderer.setSize(originalSize.x, originalSize.y);
        activeCamera.aspect = originalSize.x / originalSize.y; activeCamera.updateProjectionMatrix();

        // FIX 1: DESACTIVAR SOMBRAS PARA PLANOS
        dirLight.castShadow = false;

        // 3. Vistas Técnicas
        updateLoadingText("Vistas..."); controls.enabled=false;
        const oldCam = activeCamera; activeCamera = orthoCamera; 
        const views={}; 
        
        const box=new THREE.Box3(); 
        if(objectsInScene.length>0) objectsInScene.forEach(o=>box.expandByObject(o));
        else box.setFromCenterAndSize(new THREE.Vector3(0,0,0), new THREE.Vector3(10,10,10));
        
        const ctr=box.getCenter(new THREE.Vector3()), sz=box.getSize(new THREE.Vector3());
        const maxDim=Math.max(sz.x,sz.y,sz.z)*0.6, dist=maxDim*4;
        
        // FIX 2: ASPECTO ORTOGRÁFICO CUADRADO
        const pdfAsp = 1; 
        orthoCamera.zoom=1; orthoCamera.left=-maxDim*pdfAsp; orthoCamera.right=maxDim*pdfAsp; orthoCamera.top=maxDim; orthoCamera.bottom=-maxDim; orthoCamera.updateProjectionMatrix();

        const camPos=[
            {n:'front',p:[0,0,dist],u:[0,1,0]}, {n:'side',p:[dist,0,0],u:[0,1,0]},
            {n:'top',p:[0,dist,0],u:[0,0,-1]}, {n:'iso',p:[dist,dist,dist],u:[0,1,0]}
        ];
        
        renderer.setSize(1000, 1000);
        for(let c of camPos) {
            orthoCamera.position.set(ctr.x+c.p[0], ctr.y+c.p[1], ctr.z+c.p[2]); orthoCamera.up.set(c.u[0],c.u[1],c.u[2]); orthoCamera.lookAt(ctr);
            renderer.render(scene,orthoCamera); views[c.n]=renderer.domElement.toDataURL('image/jpeg',0.9); await wait(50);
        }
        renderer.setSize(originalSize.x, originalSize.y);

        // 4. Capturar Items
        const items=[], seen=new Set(); objectsInScene.forEach(o=>o.visible=false);
        renderer.setSize(800, 600);
        for(let o of objectsInScene) {
            if(seen.has(o.userData.ref)) continue; seen.add(o.userData.ref);
            updateLoadingText("Item: "+o.userData.name); o.visible=true;
            const b=new THREE.Box3().setFromObject(o); const c=b.getCenter(new THREE.Vector3()); const s=b.getSize(new THREE.Vector3()); const d=Math.max(s.x,s.y,s.z)*0.6;
            orthoCamera.position.set(15,15,15); orthoCamera.up.set(0,1,0); orthoCamera.lookAt(c);
            orthoCamera.left=-d*1.33; orthoCamera.right=d*1.33; orthoCamera.top=d; orthoCamera.bottom=-d; orthoCamera.updateProjectionMatrix();
            renderer.render(scene,orthoCamera);
            let fImg=renderer.domElement.toDataURL('image/jpeg',0.9);
            if(o.userData.img_2d){ try{const i=new Image();i.src=o.userData.img_2d;await new Promise(r=>{i.onload=r;i.onerror=r});if(i.width>0){const ca=document.createElement('canvas');ca.width=i.width;ca.height=i.height;ca.getContext('2d').drawImage(i,0,0);fImg=ca.toDataURL('image/jpeg',0.9);}}catch(e){} }
            items.push({d:o.userData, i:fImg}); o.visible=false; await wait(50);
        }
        renderer.setSize(originalSize.x, originalSize.y);

        // RESTAURAR SOMBRAS
        dirLight.castShadow = true;

        // 5. Restaurar
        objectsInScene.forEach(o=>o.visible=true); sky.visible=prevSky; scene.background=prevBG; 
        if(selectedObject){selectionBox.visible=true; transformControl.attach(selectedObject);}
        activeCamera=oldCam; controls.enabled=true;
        
        // 6. MAQUETACIÓN PDF
        const lg = loadedLogoBase64 || createLogoUrl();
        const date = new Date().toLocaleDateString();
        const BLUE = [74, 144, 226];

        // Pag 1: Portada
        doc.setFont("helvetica", "bold"); doc.setFontSize(30); doc.setTextColor(40); doc.text("Levipark21", m, 25); 
        doc.setFontSize(14); doc.setTextColor(100); doc.text(ref, w-m, 25, {align:'right'});
        
        const coverProp = doc.getImageProperties(imgCov);
        const maxCoverH = (h/2) + 20; 
        const maxCoverW = w - (2*m);
        const coverRatio = Math.min(maxCoverW / coverProp.width, maxCoverH / coverProp.height);
        const finalCW = coverProp.width * coverRatio;
        const finalCH = coverProp.height * coverRatio;
        const cX = m + (maxCoverW - finalCW) / 2;
        
        doc.addImage(imgCov, 'JPEG', cX, 40, finalCW, finalCH); 
        addFooter(doc, date, lg);

        // Pag 2: Vistas Técnicas
        doc.addPage(); doc.setFontSize(16); doc.setTextColor(0); doc.text("Vistas Técnicas", m, 20);
        const gw=(w-30)/2, gh=(h-60)/2; 
        
        const putView = (img, tit, x, y) => {
            doc.setFontSize(12); doc.setTextColor(100); doc.text(tit, x, y-2);
            const props = doc.getImageProperties(img);
            const r = Math.min(gw/props.width, gh/props.height);
            const fw = props.width * r; const fh = props.height * r;
            doc.addImage(img, 'JPEG', x+(gw-fw)/2, y+(gh-fh)/2, fw, fh);
        };

        putView(views.front, "Alzado", 10, 30);
        putView(views.side, "Perfil", 20+gw, 30);
        putView(views.top, "Planta", 10, 40+gh);
        putView(views.iso, "Isométrica", 20+gw, 40+gh);
        addFooter(doc, date, lg);

        // Pag 3: Presupuesto
        doc.addPage(); doc.setFontSize(18); doc.text("Presupuesto", m, 20);
        const rows = objectsInScene.map(o => [o.userData.name, o.userData.ref, "1", (o.userData.price||0).toLocaleString()+" €"]);
        const tot=totalPrice, dAm=tot*(disc/100), fin=tot-dAm, iva=fin*0.21, final=fin+iva;
        rows.push(["","","",""], ["","","Dto "+disc+"%", "-"+dAm.toLocaleString()+" €"], ["","","Base", fin.toLocaleString()+" €"], ["","","IVA 21%", iva.toLocaleString()+" €"], ["","","TOTAL", final.toLocaleString()+" €"]);
        doc.autoTable({head:[['Concepto','Ref','Ud','Precio']], body:rows, startY:30, theme:'grid', headStyles:{fillColor:BLUE}, columnStyles:{3:{halign:'right'}}}); 
        addFooter(doc, date, lg);

        // Pags 4+: Documentación
        if(items.length>0){
            doc.addPage(); doc.setFontSize(24); doc.text("Documentación", w/2, h/2, {align:'center'});
            items.forEach(i => {
                doc.addPage(); addHeader(doc, ref);
                const iProp = doc.getImageProperties(i.i);
                const maxH = (h/2)-20; const maxW = w-2*m;
                const r = Math.min(maxW/iProp.width, maxH/iProp.height);
                const fw = iProp.width * r; const fh = iProp.height * r;
                
                doc.addImage(i.i, 'JPEG', m+(maxW-fw)/2, 20, fw, fh);
                let y = maxH + 40; doc.setFontSize(18); doc.setTextColor(0); doc.text(i.d.name, m, y); y += 10;
                doc.setFontSize(12); doc.setTextColor(80); doc.text(`Ref: ${i.d.ref}`, m, y); y += 10; doc.text(`Dimensiones: ${i.d.dims || "-"}`, m, y); y += 15;
                doc.setFontSize(10); const ds = doc.splitTextToSize(i.d.desc || "", w-2*m); doc.text(ds, m, y); y += (ds.length*5) + 15;
                doc.setTextColor(0, 0, 255);
                if (i.d.url_tech && i.d.url_tech != "#") { doc.textWithLink(">> Ficha Técnica", m, y, {url:i.d.url_tech}); y+=8; }
                if (i.d.url_cert && i.d.url_cert != "#") { doc.textWithLink(">> Certificado", m, y, {url:i.d.url_cert}); y+=8; }
                doc.textWithLink(">> Ficha de Montaje", m, y, {url:i.d.url_inst||"#"});
                addFooter(doc, date, lg);
            });
        }

        doc.save("Dossier_"+ref+".pdf"); document.getElementById('loading').style.display='none';
    }

    function toggleProjection() {
        const p=activeCamera.position.clone(), t=controls.target.clone();
        activeCamera = (activeCamera===perspectiveCamera)?orthoCamera:perspectiveCamera;
        activeCamera.position.copy(p); activeCamera.lookAt(t); controls.object=activeCamera; transformControl.camera=activeCamera;
        
        // FIX 3: RECALCULAR ORTO PARA EVITAR DEFORMACIÓN
        if (activeCamera === orthoCamera) {
            const aspect = window.innerWidth / window.innerHeight;
            orthoCamera.left = -20 * aspect;
            orthoCamera.right = 20 * aspect;
            orthoCamera.top = 20;
            orthoCamera.bottom = -20;
            orthoCamera.updateProjectionMatrix();
        }

        document.getElementById('btn-projection').innerText = (activeCamera===perspectiveCamera)?"👁️ Perspectiva":"📐 Ortográfica";
    }
    function setView(v) { controls.target.set(0,0,0); const d=20; if(v==='iso')activeCamera.position.set(d,d,d); if(v==='top')activeCamera.position.set(0,d,0); if(v==='front')activeCamera.position.set(0,0,d); if(v==='side')activeCamera.position.set(d,0,0); activeCamera.lookAt(0,0,0); controls.update(); }
    function onWindowResize() { perspectiveCamera.aspect=window.innerWidth/window.innerHeight; perspectiveCamera.updateProjectionMatrix(); renderer.setSize(window.innerWidth,window.innerHeight); }
    function render() { renderer.render(scene, activeCamera); controls.update(); }

} catch (e) { alert("Error: " + e.message); }