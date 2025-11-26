import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { OBB } from 'three/addons/math/OBB.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { SAOPass } from 'three/addons/postprocessing/SAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

try {
    // --- DATOS Y CONFIG ---
    const ENV_COLORS = { white: 0xffffff, green: 0x2ecc71, blue: 0x3498db, yellow: 0xf1c40f };
    const FLOOR_COLORS = { garnet: 0xA04040, blue: 0x2980b9, green: 0x27ae60, black: 0x2c3e50 };
    const PRICE_PER_M2 = 40; 
    const LOGO_URL = "logo.png"; 
    const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRBy55ReQjx0odJ_aagHh_fjWNr-y97kPoT2stB6axgSvGZV0LLrc9n4EVysCxU4tpweWDVGld0SrAJ/pub?output=csv"; 

    let productsDB = {}; 

    // --- GLOBALES ---
    let scene, renderer, controls, perspectiveCamera, orthoCamera, activeCamera, raycaster, pointer = new THREE.Vector2();
    let transformControl; 
    let dirLight, hemiLight, sunAzimuth = 180, sunElevation = 30;
    let sky, sun;
    let gridHelper; // <--- AÑADIR ESTA VARIABLE
    let composer, outlinePass, saoPass; 
    let loadingManager, loader, textureLoader; // Gestores de carga

    let productToPlace = null, productPrice = 0, selectedObject = null, totalPrice = 0;
    let pendingModelBase64 = null; 
    let isColliding = false;

    // Herramientas
    let isMeasuring = false, measurePoints = [], measureMarkers = [], measureLine = null, measureLabel = null;
    let isDrawingFloor = false, floorPoints = [], floorMarkers = [], floorLine = null, floorLabel = null, isInputFocused = false;
    let floorMode = 'poly'; // 'poly' | 'rect'
    let rectStartPoint = null, rectPreviewMesh = null;

    // Snapping & Safety
    let isSnapping = false; 
    let showSafetyZones = true;
    const safetyZonesList = [];

    // Historial
    let reticle; 
    let historyStack = []; let historyStep = -1;
    let dragStartData = { pos: new THREE.Vector3(), rot: new THREE.Euler(), scale: new THREE.Vector3() };

    const objectsInScene = [];
    let loadedLogoBase64 = null, loadedLogoImg = null;
    let shadowPlane;

    init();

    async function init() {
        // --- 1. SETUP LOADING MANAGER ---
        loadingManager = new THREE.LoadingManager();
        loadingManager.onStart = function ( url, itemsLoaded, itemsTotal ) {
            document.getElementById('loading').style.display = 'block';
            document.getElementById('loading-text').innerText = 'Iniciando carga...';
        };
        loadingManager.onProgress = function ( url, itemsLoaded, itemsTotal ) {
            const percent = Math.round((itemsLoaded / itemsTotal) * 100);
            document.getElementById('loading-text').innerText = `Cargando activos... ${percent}%`;
        };
        loadingManager.onLoad = function ( ) {
            document.getElementById('loading').style.display = 'none';
        };
        
        loader = new GLTFLoader(loadingManager);
        textureLoader = new THREE.TextureLoader(loadingManager);

        // --- 2. ESCENA & CAMARAS ---
        scene = new THREE.Scene();

        perspectiveCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
        perspectiveCamera.position.set(10, 10, 10);
        
        const aspect = window.innerWidth / window.innerHeight;
        const d = 20;
        orthoCamera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
        orthoCamera.position.set(20, 20, 20);
        activeCamera = perspectiveCamera;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap; 
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping; 
        renderer.toneMappingExposure = 0.8;
        renderer.xr.enabled = true;
        document.body.appendChild(renderer.domElement);
        
        setupPostProcessing();

        const arBtn = ARButton.createButton(renderer, { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay'], domOverlay: { root: document.body } });
        document.body.appendChild(arBtn);

        renderer.xr.addEventListener('sessionstart', () => {
            document.body.style.background = 'transparent'; if(sky) sky.visible = false; scene.background = null; if(reticle) reticle.visible = true;
        });
        renderer.xr.addEventListener('sessionend', () => {
            document.body.style.background = '#222'; if(sky) { sky.visible = true; updateSunPosition(); } if(reticle) reticle.visible = false;
        });
        
        reticle = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        reticle.matrixAutoUpdate = false; reticle.visible = false; scene.add(reticle);

        hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.6); scene.add(hemiLight);
        dirLight = new THREE.DirectionalLight(0xffffff, 3); dirLight.castShadow = true;
        dirLight.shadow.camera.left = -100; dirLight.shadow.camera.right = 100; dirLight.shadow.camera.top = 100; dirLight.shadow.camera.bottom = -100;
        dirLight.shadow.mapSize.set(2048, 2048); dirLight.shadow.bias = -0.0001;
        scene.add(dirLight);

        const shadowGeo = new THREE.PlaneGeometry(500, 500);
        const shadowMat = new THREE.ShadowMaterial({ opacity: 0.3, color: 0x000000 });
        shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
        shadowPlane.rotation.x = -Math.PI / 2; shadowPlane.position.y = 0.001; shadowPlane.receiveShadow = true;
        scene.add(shadowPlane);
                // 100 metros de tamaño, divisiones cada 1 metro
        gridHelper = new THREE.GridHelper(100, 100, 0x888888, 0x444444);
        gridHelper.visible = false; // Empieza oculto
        gridHelper.position.y = 0.002; // Un pelín por encima del suelo para evitar z-fighting
        scene.add(gridHelper);

        controls = new OrbitControls(activeCamera, renderer.domElement); controls.enableDamping = true; 
        raycaster = new THREE.Raycaster();

        transformControl = new TransformControls(activeCamera, renderer.domElement);
        transformControl.addEventListener('dragging-changed', function (event) { 
            controls.enabled = !event.value; 
            if (event.value) { 
                if (selectedObject) { 
                    dragStartData.pos.copy(selectedObject.position); 
                    dragStartData.rot.copy(selectedObject.rotation);
                    dragStartData.scale.copy(selectedObject.scale);
                } 
            } else { 
                if (selectedObject) { 
                    if (isColliding) { 
                        selectedObject.position.copy(dragStartData.pos); 
                        selectedObject.rotation.copy(dragStartData.rot);
                        selectedObject.scale.copy(dragStartData.scale);
                        checkCollisions(); 
                        showToast('¡Colisión detectada! Movimiento revertido.', 'error');
                    } else { 
                        snapToFloor(selectedObject); 
                    } 
                    saveHistory(); 
                } 
            }
        });
        transformControl.addEventListener('change', function () { if (selectedObject) checkCollisions(); });
        scene.add(transformControl);
        
        updateSnapSettings();
        initSky();
        window.addEventListener('resize', onWindowResize);

        // --- SISTEMA BRIDGE (LZ-STRING) ---
        const urlParams = new URLSearchParams(window.location.search);
        const compressedData = urlParams.get('data');
        
        if (compressedData) {
            document.getElementById('loading').style.display = 'block';
            updateLoadingText("Descomprimiendo proyecto...");
            try {
                const jsonString = window.LZString.decompressFromEncodedURIComponent(compressedData);
                if(jsonString) {
                    const data = JSON.parse(jsonString);
                    loadProjectData(data);
                    window.history.replaceState({}, document.title, window.location.pathname);
                    showToast('Proyecto móvil cargado correctamente', 'success');
                } else {
                    showToast('Datos dañados o ilegibles', 'error');
                }
            } catch (err) { console.error(err); showToast('Error al cargar proyecto móvil', 'error'); }
            document.getElementById('loading').style.display = 'none';
        } else {
            await loadSheetData();
            loadLocalStorage();
        }

        setupEventListeners();
        setupUploadSystem();
        preloadLogo();
        
        setInterval(saveToLocalStorage, 30000);
        renderer.setAnimationLoop(render);
    }

    // --- HELPER FUNCTIONS FOR UI (MODALS & TOASTS) ---
    function askUser(title, defaultValue = "", isAlert = false) {
        return new Promise((resolve) => {
            const modal = document.getElementById('custom-modal');
            const titleEl = document.getElementById('modal-title');
            const input = document.getElementById('modal-input');
            const btnOk = document.getElementById('modal-ok');
            const btnCancel = document.getElementById('modal-cancel');
            const desc = document.getElementById('modal-desc');

            titleEl.innerText = title;
            input.value = defaultValue;
            
            if(isAlert) {
                input.style.display = 'none';
                btnCancel.style.display = 'none';
                desc.style.display = 'block';
                desc.innerText = defaultValue; // Usamos defaultValue como texto del mensaje
            } else {
                input.style.display = 'block';
                btnCancel.style.display = 'block';
                desc.style.display = 'none';
                input.focus();
            }

            modal.style.display = 'flex';
            
            // Clean old events
            const newBtnOk = btnOk.cloneNode(true);
            const newBtnCancel = btnCancel.cloneNode(true);
            btnOk.parentNode.replaceChild(newBtnOk, btnOk);
            btnCancel.parentNode.replaceChild(newBtnCancel, btnCancel);

            const close = (val) => {
                modal.style.display = 'none';
                resolve(val);
            };

            newBtnOk.onclick = () => close(isAlert ? true : input.value);
            newBtnCancel.onclick = () => close(null);
            
            if(!isAlert) {
                input.onkeydown = (e) => { if(e.key === 'Enter') close(input.value); };
            }
        });
    }

    function showMessage(title, text) {
        return askUser(title, text, true);
    }

    function showToast(msg, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        
        let icon = 'ℹ️';
        if(type==='success') icon='✅';
        if(type==='error') icon='❌';

        toast.innerHTML = `<span>${icon}</span> <span>${msg}</span>`;
        container.appendChild(toast);
        
        // Animacion entrada
        requestAnimationFrame(() => toast.classList.add('show'));

        // Eliminar
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function updateLoadingText(t) { document.getElementById('loading-text').innerText=t; }

    function setupPostProcessing() {
        composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, activeCamera));
        // SAO desactivado por rendimiento, pero el código está aquí si se quiere activar
        // saoPass = new SAOPass(scene, activeCamera, false, true);
        // composer.addPass(saoPass);
        outlinePass = new OutlinePass(new THREE.Vector2(window.innerWidth, window.innerHeight), scene, activeCamera);
        outlinePass.edgeStrength = 3.0; outlinePass.visibleEdgeColor.setHex(0xffff00); outlinePass.hiddenEdgeColor.setHex(0xffaa00);
        composer.addPass(outlinePass);
        composer.addPass(new OutputPass());
    }

    function initSky() {
        sky = new Sky(); sky.scale.setScalar(450000); scene.add(sky); sun = new THREE.Vector3();
        const uniforms = sky.material.uniforms; uniforms['turbidity'].value = 10; uniforms['rayleigh'].value = 2; uniforms['mieCoefficient'].value = 0.005; uniforms['mieDirectionalG'].value = 0.8;
        updateSunPosition();
    }
    function updateSunPosition() {
        const phi = THREE.MathUtils.degToRad(90 - sunElevation); const theta = THREE.MathUtils.degToRad(sunAzimuth);
        sun.setFromSphericalCoords(1, phi, theta); sky.material.uniforms['sunPosition'].value.copy(sun);
        dirLight.position.setFromSphericalCoords(100, phi, theta);
        
        if (renderer && sky.visible) { 
            const pmremGenerator = new THREE.PMREMGenerator(renderer); 
            scene.environment = pmremGenerator.fromScene(sky).texture; 
            scene.background = null; 
        } else {
            scene.environment = null;
            scene.background = new THREE.Color(0xffffff);
        }
    }

    async function loadSheetData() { if(SHEET_URL) { try { const r=await fetch(SHEET_URL); productsDB=parseCSVtoTree(await r.text()); initCatalogUI(); } catch(e){} } }
    function parseCSVtoTree(csv) {
        const rows = csv.split('\n').map(row => row.trim()).filter(row => row.length > 0);
        const headers = rows[0].split(',').map(h => h.trim().toUpperCase());
        const db = {};
        for (let i = 1; i < rows.length; i++) {
            const values = rows[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/); const item = {};
            headers.forEach((header, index) => { let val = values[index]?values[index].trim():""; val = val.replace(/^"|"$/g, ''); item[header] = val; });
            const linea = item['LINEA'] || "Sin Línea"; const cat = item['CATEGORIA'] || "Varios";
            const productObj = { name: item['NOMBRE'], file: item['ARCHIVO_GLB'], price: parseFloat(item['PRECIO']) || 0, ref: item['REF'] || "", desc: item['DESC'] || "", dims: item['DIMS'] || "", url_tech: item['URL_TECH']||"#", url_cert: item['URL_CERT']||"#", url_inst: item['URL_INST']||"#", img_2d: item['IMG_2D']||"" };
            if (!db[linea]) db[linea] = {}; if (!db[linea][cat]) db[linea][cat] = []; db[linea][cat].push(productObj);
        }
        return db;
    }
    function initCatalogUI() {
        const select = document.getElementById('line-select'); if(!select) return; select.innerHTML = "";
        const lines = Object.keys(productsDB); if(lines.length>0) { lines.forEach(l => { const o = document.createElement('option'); o.value = l; o.innerText = l; select.appendChild(o); }); select.addEventListener('change', (e) => renderCategories(e.target.value)); renderCategories(lines[0]); }
    }
    
    function renderCategories(l) { 
        const c = document.getElementById('dynamic-catalog'); c.innerHTML=""; if(!productsDB[l]) return;
        for(const [cat, prods] of Object.entries(productsDB[l])) {
            const b=document.createElement('button'); b.className="accordion-btn"; b.innerText=cat;
            const p=document.createElement('div'); p.className="panel-products";
            prods.forEach(prod => { 
                const bb=document.createElement('button'); bb.className="btn-product"; bb.innerHTML=`${prod.name} <span style="float:right;opacity:0.7">${prod.price}€</span>`; 
                bb.onclick=()=>{prepareToPlace(prod,bb);if(window.innerWidth<600)document.getElementById('ui-panel').style.display='none'}; 
                p.appendChild(bb); 
            });
            b.onclick=()=>{b.classList.toggle("active-acc"); p.style.maxHeight=p.style.maxHeight?null:p.scrollHeight+"px"}; c.append(b,p);
        }
    }
    
    function prepareToPlace(d, b) { 
        if(isMeasuring) toggleMeasureMode(); if(isDrawingFloor) toggleFloorMode(); deselectObject(); 
        productToPlace=d.file; productPrice=d.price; window.currentProductData=d; pendingModelBase64=null; 
        document.querySelectorAll('.btn-product').forEach(btn=>btn.classList.remove('active')); b.classList.add('active'); 
        showToast(`Seleccionado: ${d.name}. Haz click en el suelo.`, 'info');
    }

    function setupUploadSystem() {
        document.getElementById('btn-upload-trigger').addEventListener('click', () => document.getElementById('file-upload').click());
        document.getElementById('file-upload').addEventListener('change', (e) => {
            const file = e.target.files[0]; if (!file) return;
            const name = file.name.toLowerCase();
            if (name.endsWith('.glb') || name.endsWith('.gltf')) {
                const reader = new FileReader(); reader.readAsDataURL(file);
                reader.onload = function(evt) { prepareImportedModel(URL.createObjectURL(file), file.name, evt.target.result); };
            } else if (name.endsWith('.jpg') || name.endsWith('.png') || name.endsWith('.jpeg')) {
                const url = URL.createObjectURL(file);
                if (selectedObject && selectedObject.userData.isFloor) applyTextureToSelectedFloor(url, file.name);
                else prepareCustomFloor(url, file.name);
            }
            e.target.value = "";
        });
    }

    async function prepareImportedModel(url, filename, base64Data) {
        if (isMeasuring) toggleMeasureMode(); if (isDrawingFloor) toggleFloorMode(); deselectObject();
        const userRef = await askUser("Referencia del modelo:", "CUSTOM") || "CUSTOM";
        const priceStr = await askUser("Precio unitario (€):", "0");
        const userPrice = parseFloat(priceStr) || 0;

        window.currentProductData = { name: filename, price: userPrice, ref: userRef, desc: "Importado", dims: "Custom" };
        productToPlace = url; productPrice = userPrice; pendingModelBase64 = base64Data;
        showToast("Haz click en el suelo para colocar el modelo importado.", 'success');
    }

    function applyTextureToSelectedFloor(url, filename) {
        const floor = selectedObject; 
        // Usamos textureLoader del manager
        textureLoader.load(url, (t) => {
            t.colorSpace = THREE.SRGBColorSpace; 
            t.wrapS = t.wrapT = THREE.RepeatWrapping; 
            t.center.set(0.5, 0.5); t.rotation = 0; t.repeat.set(1, 1); t.offset.set(0, 0);
            
            floor.material.map = t; 
            floor.material.color.setHex(0xffffff); 
            floor.material.transparent = true;
            floor.material.needsUpdate = true;
            
            floor.userData.img_2d = url; floor.userData.name = "Suelo: " + filename;
            updateUI(); saveHistory();
            showToast("Textura aplicada al suelo.", 'success');
        });
    }

    async function prepareCustomFloor(url, filename) {
        const widthStr = await askUser("Ancho real de la imagen (m):", "10");
        const width = parseFloat(widthStr);
        if(isNaN(width)) return;

        textureLoader.load(url, (t) => {
            t.colorSpace = THREE.SRGBColorSpace; const asp = t.image.height / t.image.width; const height = width * asp; const area = width * height; 
            t.center.set(0.5, 0.5);
            const m = new THREE.Mesh(new THREE.PlaneGeometry(width, height), 
                new THREE.MeshStandardMaterial({ map: t, roughness:0.6, metalness:0.1, transparent: true, color: 0xffffff })); 
            m.rotation.x = -Math.PI/2; m.position.y = 0.05; m.receiveShadow = true;
            m.userData = { price: 0, locked:false, collides:true, isFloor:true, name: "Suelo: "+filename, ref:"IMG", dims:`${width}x${height.toFixed(2)}`, area:area.toFixed(2), img_2d:url };
            scene.add(m); objectsInScene.push(m); updateBudget(); selectObject(m); saveHistory();
            showToast("Suelo personalizado creado.", 'success');
        });
    }

    function toggleSnap() {
        isSnapping = !isSnapping;
        const btn = document.getElementById('btn-snap');
        if(isSnapping) { btn.classList.add('active-snap'); showToast('Snapping Activado', 'info'); } 
        else { btn.classList.remove('active-snap'); showToast('Snapping Desactivado', 'info'); }
        updateSnapSettings();
    }
    function updateSnapSettings() {
        if(isSnapping) {
            transformControl.setTranslationSnap(0.5); transformControl.setRotationSnap(THREE.MathUtils.degToRad(45));
        } else {
            transformControl.setTranslationSnap(null); transformControl.setRotationSnap(THREE.MathUtils.degToRad(15));
        }
    }
    
    function toggleSafetyZones() {
        showSafetyZones = !showSafetyZones;
        const btn = document.getElementById('btn-toggle-safety');
        if(showSafetyZones) { btn.classList.remove('active-safety'); showToast('Zonas de seguridad visibles', 'info'); }
        else { btn.classList.add('active-safety'); showToast('Zonas de seguridad ocultas', 'info'); }
        safetyZonesList.forEach(obj => { obj.visible = showSafetyZones; });
    }

    function processSafetyZones(model) {
        console.groupCollapsed("🔍 Analizando modelo importado");
        model.traverse(node => {
            if (node.isMesh) {
                const meshName = node.name ? node.name.toLowerCase() : "";
                const matName = (node.material && node.material.name) ? node.material.name.toLowerCase() : "";
                console.log(`- Mesh: ${meshName} | Mat: ${matName}`);

                const isSafetyName = meshName.includes('seguridad') || meshName.includes('zona') || meshName.includes('safety');
                const isSafetyMat = matName.includes('seguridad') || matName.includes('zona') || matName.includes('safety');

                if (isSafetyName || isSafetyMat) {
                    console.log("   ✅ ¡Detectada Zona de Seguridad!");
                    node.material = new THREE.MeshBasicMaterial({ 
                        color: 0xff0000, 
                        transparent: true, 
                        opacity: 0.3, 
                        depthWrite: false,
                        side: THREE.DoubleSide 
                    });
                    node.visible = showSafetyZones;
                    node.userData.isSafetyZone = true;
                    safetyZonesList.push(node);
                }
            }
        });
        console.groupEnd();
    }

    function saveToLocalStorage() {
        const d = { date: new Date().toISOString(), totalPrice: totalPrice, items: [] };
        objectsInScene.forEach(obj => { 
            // Guardamos escala tambien
            const data = obj.userData;
            data.scale = { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z };
            d.items.push({ type: obj.userData.isFloor?'floor':'model', pos: obj.position, rot: obj.rotation, scale: obj.scale, data: data }); 
        });
        localStorage.setItem('levipark_autosave', JSON.stringify(d));
    }
    function loadLocalStorage() { const s = localStorage.getItem('levipark_autosave'); if(s) { try { loadProjectData(JSON.parse(s)); } catch(e){} } }

    async function saveProject() { 
        let name = await askUser("Nombre del archivo:", "proyecto");
        if (!name) return;
        if (name.trim() === "") name = "proyecto"; 
        if (!name.toLowerCase().endsWith(".json")) { name += ".json"; }
        
        saveToLocalStorage(); 
        const jsonContent = JSON.stringify(JSON.parse(localStorage.getItem('levipark_autosave')));
        const a = document.createElement('a'); a.href = "data:text/json;charset=utf-8," + encodeURIComponent(jsonContent); a.download = name; a.click(); 
        showToast("Proyecto descargado.", 'success');
    }

    function loadProject(e) { const f=e.target.files[0]; if(!f)return; const r=new FileReader(); r.onload=(ev)=>{try{loadProjectData(JSON.parse(ev.target.result)); showToast("Proyecto cargado.", 'success');}catch(x){ showToast("Error al leer archivo.", 'error'); }}; r.readAsText(f); e.target.value=''; }
    
    function loadProjectData(j) { 
        resetScene(); 
        j.items.forEach(i => i.type==='floor'?reconstructFloor(i):reconstructModel(i)); 
        setTimeout(() => saveHistory(), 1000); 
    }
    
    function saveHistory() { 
        if (historyStep < historyStack.length - 1) historyStack = historyStack.slice(0, historyStep + 1); 
        const snapshot = objectsInScene.map(obj => ({ 
            type: obj.userData.isFloor?'floor':'model', 
            pos: obj.position.clone(), 
            rot: obj.rotation.clone(), 
            scale: obj.scale.clone(), // Guardamos escala
            data: JSON.parse(JSON.stringify(obj.userData)) 
        }));
        historyStack.push(JSON.stringify(snapshot)); 
        historyStep++; 
        if (historyStack.length > 50) { historyStack.shift(); historyStep--; } 
    }
    
    function undo() { 
        if (historyStep > 0) { 
            historyStep--; 
            restoreState(historyStack[historyStep]); 
            showToast("Deshacer", 'info');
        } 
    }
    function redo() { 
        if (historyStep < historyStack.length - 1) { 
            historyStep++; 
            restoreState(historyStack[historyStep]); 
            showToast("Rehacer", 'info');
        } 
    }
    
    function restoreState(json) {
        objectsInScene.forEach(o=>scene.remove(o)); objectsInScene.length=0; totalPrice=0; deselectObject();
        JSON.parse(json).forEach(i => i.type==='floor'?reconstructFloor(i):reconstructModel(i)); updateBudget();
    }

    function reconstructFloor(i) {
        // Manejo de escala antigua si no existe
        const sc = i.scale || {x:1, y:1, z:1};

        if(i.data.dims && i.data.dims.includes("x")) { 
            const dims = i.data.dims.split("x"); const w = parseFloat(dims[0]); const h = parseFloat(dims[1]);
            let mat;
            if(i.data.img_2d && i.data.img_2d.startsWith("data:")) {
                const tex = textureLoader.load(i.data.img_2d);
                tex.colorSpace = THREE.SRGBColorSpace; tex.center.set(0.5, 0.5);
                if(i.data.texSettings) { tex.repeat.set(i.data.texSettings.repeat, i.data.texSettings.repeat); tex.rotation = i.data.texSettings.rotation; tex.offset.set(i.data.texSettings.offsetX, i.data.texSettings.offsetY); }
                mat = new THREE.MeshStandardMaterial({ map: tex, roughness:0.6, metalness:0.1, transparent: true, color: 0xffffff }); 
            } else { mat = new THREE.MeshStandardMaterial({ color: FLOOR_COLORS.garnet, roughness:0.5 }); }
            const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
            m.rotation.set(i.rot._x, i.rot._y, i.rot._z); m.position.set(i.pos.x, i.pos.y, i.pos.z); m.scale.set(sc.x, sc.y, sc.z);
            m.userData = i.data; m.receiveShadow=true;
            scene.add(m); objectsInScene.push(m); totalPrice += (m.userData.price||0); updateBudget();
        } else if(i.data.points) { 
            const s = new THREE.Shape(); i.data.points.forEach((p,k) => k===0?s.moveTo(p.x,p.z):s.lineTo(p.x,p.z)); s.lineTo(i.data.points[0].x, i.data.points[0].z);
            let mat;
            if(i.data.img_2d) {
                const tex = textureLoader.load(i.data.img_2d);
                tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.center.set(0.5,0.5);
                if(i.data.texSettings) { tex.repeat.set(i.data.texSettings.repeat, i.data.texSettings.repeat); tex.rotation = i.data.texSettings.rotation; tex.offset.set(i.data.texSettings.offsetX, i.data.texSettings.offsetY); }
                mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, color: 0xffffff });
            } else { mat = new THREE.MeshStandardMaterial({ color: FLOOR_COLORS.garnet }); }
            const m = new THREE.Mesh(new THREE.ExtrudeGeometry(s,{depth:0.05, bevelEnabled:false}), mat);
            m.rotation.set(i.rot._x, i.rot._y, i.rot._z); m.position.set(i.pos.x, i.pos.y, i.pos.z); m.scale.set(sc.x, sc.y, sc.z);
            m.userData = i.data; m.receiveShadow=true;
            scene.add(m); objectsInScene.push(m); totalPrice += (m.userData.price||0); updateBudget();
        }
    }

    function reconstructModel(i) {
        let u = i.data.modelBase64 || i.data.modelFile; if(!u || u.startsWith('blob:')) return;
        const sc = i.scale || {x:1, y:1, z:1};
        loader.load(u, (g)=>{
            const m=g.scene; m.traverse(n=>{ if(n.isMesh){ n.castShadow=true;n.receiveShadow=true; } });
            processSafetyZones(m); 
            m.position.set(i.pos.x, i.pos.y, i.pos.z); m.rotation.set(i.rot._x, i.rot._y, i.rot._z); m.scale.set(sc.x, sc.y, sc.z);
            m.userData = i.data;
            scene.add(m); objectsInScene.push(m); totalPrice += (i.data.price||0); updateBudget();
        });
    }

    function setupEventListeners() {
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('keydown', onKeyDown);

        // UI
        document.getElementById('btn-toggle-menu').addEventListener('click', () => toggleDisplay('ui-panel'));
        document.getElementById('btn-close-menu').addEventListener('click', () => document.getElementById('ui-panel').style.display = 'none');
        document.getElementById('btn-toggle-env').addEventListener('click', () => toggleDisplay('env-panel'));
        document.getElementById('btn-min-edit').addEventListener('click', () => toggleDisplay('edit-content'));

        // Snap & Safety
        document.getElementById('btn-snap').addEventListener('click', toggleSnap);
        document.getElementById('btn-toggle-safety').addEventListener('click', toggleSafetyZones);

        // Floor Modes
        document.getElementById('mode-poly').addEventListener('click', () => setFloorMode('poly'));
        document.getElementById('mode-rect').addEventListener('click', () => setFloorMode('rect'));

        // Controles de Ambiente
        document.getElementById('env-white').addEventListener('click', () => { sky.visible=false; updateSunPosition(); });
        document.getElementById('env-morning').addEventListener('click', () => { sky.visible=true; sunElevation=15; sunAzimuth=90; updateEnvUI(); updateSunPosition(); });
        document.getElementById('env-noon').addEventListener('click', () => { sky.visible=true; sunElevation=80; sunAzimuth=180; updateEnvUI(); updateSunPosition(); });
        document.getElementById('env-evening').addEventListener('click', () => { sky.visible=true; sunElevation=5; sunAzimuth=270; updateEnvUI(); updateSunPosition(); });
        
        document.getElementById('sun-azimuth').addEventListener('input', (e) => { sunAzimuth=e.target.value; updateSunPosition(); });
        document.getElementById('sun-elevation').addEventListener('input', (e) => { sunElevation=e.target.value; updateSunPosition(); });
        document.getElementById('light-intensity').addEventListener('input', (e) => { dirLight.intensity=e.target.value; });

        // Inputs
        document.querySelectorAll('.input-box').forEach(i => { i.addEventListener('focus', ()=>isInputFocused=true); i.addEventListener('blur', ()=>isInputFocused=false); i.addEventListener('input', updateFloorFromInput); });
        
        // Texture Mapping
        document.getElementById('tex-scale').addEventListener('input', updateTextureMapping);
        document.getElementById('tex-rotate').addEventListener('input', updateTextureMapping);
        document.getElementById('tex-off-x').addEventListener('input', updateTextureMapping);
        document.getElementById('tex-off-y').addEventListener('input', updateTextureMapping);

        document.getElementById('btn-floor-upload-tex').addEventListener('click', () => {
            document.getElementById('file-upload').click();
        });

        // Buttons
        document.getElementById('btn-screenshot').addEventListener('click', takeScreenshot);
        document.getElementById('btn-export-pdf').addEventListener('click', generateDossier);
        document.getElementById('btn-projection').addEventListener('click', toggleProjection);
        document.getElementById('btn-save-project').addEventListener('click', saveProject);
        document.getElementById('btn-load-project').addEventListener('click', () => document.getElementById('project-upload').click());
        document.getElementById('project-upload').addEventListener('change', loadProject);
        
        // Botón Mobile AR
        document.getElementById('btn-mobile-ar').addEventListener('click', exportToMobile);
        
        document.getElementById('view-iso').addEventListener('click', ()=>setView('iso')); 
        document.getElementById('view-top').addEventListener('click', ()=>setView('top'));
        
        document.getElementById('btn-measure').addEventListener('click', toggleMeasureMode); 
        document.getElementById('btn-floor').addEventListener('click', toggleFloorMode);
        document.getElementById('btn-add-point').addEventListener('click', addPointFromInput); 
        document.getElementById('btn-close-floor').addEventListener('click', ()=>{finishFloor();toggleFloorMode();});
        document.getElementById('clear-measures').addEventListener('click', clearMeasurements);

        document.getElementById('btn-reset').addEventListener('click', resetScene); 
        document.getElementById('btn-lock').addEventListener('click', toggleLock);
        document.getElementById('btn-collision').addEventListener('click', toggleObjectCollision); 
        document.getElementById('btn-delete').addEventListener('click', deleteSelected);
        document.getElementById('btn-clone').addEventListener('click', cloneSelected);
        document.getElementById('btn-undo').addEventListener('click', undo); 
        document.getElementById('btn-redo').addEventListener('click', redo);

        document.getElementById('mode-translate').addEventListener('click', ()=>setGizmoMode('translate')); 
        document.getElementById('mode-rotate').addEventListener('click', ()=>setGizmoMode('rotate'));
        document.getElementById('mode-scale').addEventListener('click', ()=>setGizmoMode('scale'));
        // 1. Botón Grid
        document.getElementById('btn-toggle-grid').addEventListener('click', toggleGrid);
        
        // 2. Buscador
        document.getElementById('catalog-search').addEventListener('input', (e) => filterCatalog(e.target.value));

        // 3. Botón Lista
        document.getElementById('btn-show-list').addEventListener('click', updateAndShowList);

    }

    function updateEnvUI() {
        document.getElementById('sun-azimuth').value = sunAzimuth;
        document.getElementById('sun-elevation').value = sunElevation;
    }
    
    // --- EXPORTAR A MÓVIL (LZ-STRING) ---
    async function exportToMobile() {
        if(objectsInScene.length === 0) { showMessage("Aviso", "El proyecto está vacío."); return; }
        
        document.getElementById('loading').style.display='block';
        updateLoadingText("Comprimiendo enlace...");
        
        // Pequeño delay para que la UI se actualice antes del bloqueo por LZString
        await wait(100);

        const cleanItems = objectsInScene.map(obj => {
            const dataCopy = JSON.parse(JSON.stringify(obj.userData));
            if (dataCopy.img_2d && dataCopy.img_2d.startsWith('data:')) { delete dataCopy.img_2d; }
            if (dataCopy.modelBase64 && dataCopy.modelBase64.length > 1000) { delete dataCopy.modelBase64; }
            
            return {
                type: obj.userData.isFloor ? 'floor' : 'model',
                pos: { x: parseFloat(obj.position.x.toFixed(3)), y: parseFloat(obj.position.y.toFixed(3)), z: parseFloat(obj.position.z.toFixed(3)) },
                rot: { _x: parseFloat(obj.rotation.x.toFixed(3)), _y: parseFloat(obj.rotation.y.toFixed(3)), _z: parseFloat(obj.rotation.z.toFixed(3)) },
                scale: { x: parseFloat(obj.scale.x.toFixed(3)), y: parseFloat(obj.scale.y.toFixed(3)), z: parseFloat(obj.scale.z.toFixed(3)) },
                data: dataCopy
            };
        });

        const projectData = { totalPrice: totalPrice, items: cleanItems };
        
        try {
            const jsonString = JSON.stringify(projectData);
            const compressed = window.LZString.compressToEncodedURIComponent(jsonString);
            const currentUrl = window.location.href.split('?')[0];
            const bridgeUrl = `${currentUrl}?data=${compressed}`;
            
            if(bridgeUrl.length > 2500) {
                showMessage("Aviso", "El proyecto es demasiado complejo para un código QR (demasiados objetos). Prueba a eliminar algunos elementos.");
            } else {
                showQR(bridgeUrl);
            }
        } catch(e) {
            console.error(e);
            showMessage("Error", "Error al generar QR.");
        } finally {
            document.getElementById('loading').style.display='none';
        }
    }
    
    function showQR(url) {
        const qrContainer = document.getElementById('qrcode');
        qrContainer.innerHTML = "";
        new window.QRCode(qrContainer, {
            text: url,
            width: 200,
            height: 200,
            colorDark : "#000000",
            colorLight : "#ffffff",
            correctLevel : window.QRCode.CorrectLevel.L
        });
        document.getElementById('qr-modal').style.display = 'flex';
    }

    function onKeyDown(e) { 
        if(isInputFocused) return;
        if(e.key==='Delete') deleteSelected(); 
        if(e.key==='t') setGizmoMode('translate'); 
        if(e.key==='r') setGizmoMode('rotate');
        if(e.key==='e') setGizmoMode('scale');
        if(e.key==='c' || e.key==='C') cloneSelected();
        if(e.key==='s' || e.key==='S') toggleSnap();
        if(e.ctrlKey && e.key==='z') undo(); 
        if(e.ctrlKey && e.key==='y') redo();
    }

    function onPointerDown(event) {
        if (event.target.closest('.modal-overlay')) return;
        if (event.target.closest('#ui-panel') || event.target.closest('#edit-panel') || event.target.closest('#env-panel') || event.target.closest('#floor-input-panel') || event.target.closest('#action-panel') || event.target.closest('#history-controls') || event.target.closest('#top-bar-controls') || event.target.closest('#qr-modal')) return;
        if (transformControl.axis) return;
        
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1; pointer.y = - (event.clientY / window.innerHeight) * 2 + 1; raycaster.setFromCamera(pointer, activeCamera); 

        if (renderer.xr.isPresenting && productToPlace && reticle.visible) { placeObject(reticle.position); return; }
        
        if (isDrawingFloor) { 
            const i = raycaster.intersectObject(shadowPlane); 
            if (i.length>0) {
                if (floorMode === 'poly') {
                    addFloorPoint(i[0].point); 
                } else if (floorMode === 'rect') {
                    rectStartPoint = i[0].point; 
                    const g = new THREE.PlaneGeometry(0.1, 0.1); g.rotateX(-Math.PI/2);
                    rectPreviewMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x9b59b6, transparent: true, opacity: 0.5 }));
                    rectPreviewMesh.position.copy(rectStartPoint); rectPreviewMesh.position.y += 0.02;
                    scene.add(rectPreviewMesh);
                }
            }
            return; 
        }

        if (isMeasuring) { const i = raycaster.intersectObjects([...objectsInScene, shadowPlane], true); if(i.length>0) { if(measurePoints.length===2) clearMeasurements(); measurePoints.push(i[0].point); createMeasureMarker(i[0].point); if(measurePoints.length===2) updateMeasureLine(i[0].point); } return; }
        if (productToPlace) { const i = raycaster.intersectObject(shadowPlane); if (i.length>0) placeObject(i[0].point); return; }

        const i = raycaster.intersectObjects(objectsInScene, true);
        if (i.length > 0) { let s = i[0].object; while (s.parent && !objectsInScene.includes(s)) s = s.parent; if(objectsInScene.includes(s)) selectObject(s); }
        else deselectObject();
    }

    function onPointerMove(event) {
        if (isInputFocused) return;
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1; pointer.y = - (event.clientY / window.innerHeight) * 2 + 1; raycaster.setFromCamera(pointer, activeCamera);
        if (isDrawingFloor && floorMode === 'poly' && floorPoints.length>0) { const i = raycaster.intersectObject(shadowPlane); if(i.length>0) updateFloorDraft(i[0].point); }
        if (isDrawingFloor && floorMode === 'rect' && rectStartPoint && rectPreviewMesh) {
            const i = raycaster.intersectObject(shadowPlane);
            if (i.length > 0) {
                const end = i[0].point;
                const width = Math.abs(end.x - rectStartPoint.x);
                const depth = Math.abs(end.z - rectStartPoint.z);
                const centerX = (rectStartPoint.x + end.x) / 2;
                const centerZ = (rectStartPoint.z + end.z) / 2;
                rectPreviewMesh.scale.set(Math.max(0.1, width), Math.max(0.1, depth), 1); 
                rectPreviewMesh.position.set(centerX, 0.02, centerZ);
                updateFloorInfoLabel(`${width.toFixed(2)}m x ${depth.toFixed(2)}m`, new THREE.Vector3(centerX, 0, centerZ));
            }
        }
        if (isMeasuring && measurePoints.length===1) { const i = raycaster.intersectObjects([...objectsInScene, shadowPlane], true); if(i.length>0) updateMeasureLine(i[0].point); }
    }

    function onPointerUp(event) {
        if (isDrawingFloor && floorMode === 'rect' && rectStartPoint && rectPreviewMesh) {
            const width = rectPreviewMesh.scale.x; const depth = rectPreviewMesh.scale.y; const pos = rectPreviewMesh.position.clone();
            scene.remove(rectPreviewMesh); scene.remove(floorLabel); rectStartPoint = null; rectPreviewMesh = null;
            if (width < 0.2 || depth < 0.2) return; 
            const area = width * depth; const pr = Math.round(area * PRICE_PER_M2);
            const mat = new THREE.MeshStandardMaterial({ color: FLOOR_COLORS.garnet, roughness:0.5 });
            const m = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), mat);
            m.rotation.x = -Math.PI/2; m.position.set(pos.x, 0.01, pos.z); m.receiveShadow = true; m.castShadow = true;
            m.userData = { price: pr, locked:false, collides:true, isFloor:true, area: area.toFixed(2), name: "Suelo Rectangular", ref: "S-Rect", dims: `${width.toFixed(2)}x${depth.toFixed(2)}` };
            scene.add(m); objectsInScene.push(m); totalPrice += pr; updateBudget(); selectObject(m); saveHistory(); toggleFloorMode();
        }
    }

    function setFloorMode(m) {
        floorMode = m;
        document.getElementById('mode-poly').style.background = m==='poly' ? '#4a90e2' : '#444';
        document.getElementById('mode-rect').style.background = m==='rect' ? '#4a90e2' : '#444';
        document.getElementById('poly-inputs').style.display = m==='poly' ? 'block' : 'none';
        document.getElementById('rect-inputs').style.display = m==='rect' ? 'block' : 'none';
        clearFloorDraft();
    }
    
    function toggleFloorMode() { 
        if(isMeasuring) toggleMeasureMode(); 
        isDrawingFloor=!isDrawingFloor; 
        const b=document.getElementById('btn-floor'),p=document.getElementById('floor-input-panel'); 
        if(isDrawingFloor){ b.classList.add('active-tool');b.innerText="✏️ Cancel";p.style.display='block';deselectObject(); setFloorMode('poly'); }
        else{ b.classList.remove('active-tool');b.innerText="✏️ Suelo";p.style.display='none';clearFloorDraft(); } 
    }

    function updateTextureMapping() {
        if (!selectedObject || !selectedObject.userData.isFloor || !selectedObject.material.map) return;
        const scale = parseFloat(document.getElementById('tex-scale').value);
        const rot = parseFloat(document.getElementById('tex-rotate').value);
        const offX = parseFloat(document.getElementById('tex-off-x').value);
        const offY = parseFloat(document.getElementById('tex-off-y').value);
        const tex = selectedObject.material.map;
        tex.repeat.set(scale, scale); tex.rotation = rot; tex.offset.set(offX, offY);
        selectedObject.userData.texSettings = { repeat: scale, rotation: rot, offsetX: offX, offsetY: offY };
    }

    function selectObject(o) { 
        selectedObject=o; outlinePass.selectedObjects = [o];
        if(!o.userData.locked) transformControl.attach(o); else transformControl.detach(); 
        document.getElementById('edit-panel').style.display='block'; 
        document.getElementById('edit-floor-specific').style.display=o.userData.isFloor?'block':'none'; 
        const texControls = document.getElementById('texture-mapping-controls');
        if (o.userData.isFloor && o.material.map) {
            texControls.style.display = 'block';
            const s = o.userData.texSettings || { repeat: 1, rotation: 0, offsetX: 0, offsetY: 0 };
            document.getElementById('tex-scale').value = s.repeat; document.getElementById('tex-rotate').value = s.rotation;
            document.getElementById('tex-off-x').value = s.offsetX; document.getElementById('tex-off-y').value = s.offsetY;
        } else { texControls.style.display = 'none'; }
        if(o.userData.isFloor) document.getElementById('floor-price-display').innerText=o.userData.price||0; 
        updateUI(); 
    }

    function updateUI() { 
        if(!selectedObject) return; 
        const l=document.getElementById('btn-lock'), c=document.getElementById('btn-collision'); 
        if(selectedObject.userData.locked){l.innerText="🔒";l.classList.add('is-locked');transformControl.detach();}else{l.innerText="🔓";l.classList.remove('is-locked');if(transformControl.object!==selectedObject)transformControl.attach(selectedObject);} 
        if(selectedObject.userData.collides){c.innerText="💥 ON";c.classList.remove('is-inactive');}else{c.innerText="👻 OFF";c.classList.add('is-inactive');} 
    }
    
    function deselectObject() { selectedObject=null; outlinePass.selectedObjects = []; transformControl.detach(); document.getElementById('edit-panel').style.display='none'; }
    function deleteSelected() { if(selectedObject&&!selectedObject.userData.locked){scene.remove(selectedObject);objectsInScene.splice(objectsInScene.indexOf(selectedObject),1);totalPrice-=selectedObject.userData.price||0;updateBudget();deselectObject(); saveHistory(); showToast("Objeto eliminado", 'info'); } }
    function resetScene() { objectsInScene.forEach(o=>scene.remove(o)); objectsInScene.length=0; totalPrice=0; updateBudget(); deselectObject(); clearMeasurements(); clearFloorDraft(); saveHistory(); showToast("Escena reiniciada", 'info'); }
    function updateBudget() { document.getElementById('budget-box').innerText=totalPrice.toLocaleString('es-ES')+" €"; }
    function toggleLock() { if(selectedObject){selectedObject.userData.locked=!selectedObject.userData.locked;updateUI(); saveHistory();} }
    function toggleObjectCollision() { if(selectedObject){selectedObject.userData.collides=!selectedObject.userData.collides;updateUI(); checkCollisions(); saveHistory();} }
    function snapToFloor(obj) { if (!obj || obj.userData.isFloor) return; const box = new THREE.Box3().setFromObject(obj); if (Math.abs(box.min.y) > 0.01) { obj.position.y -= box.min.y; obj.updateMatrixWorld(); } }
    function getOBBFromObject(obj) { const prevRot = obj.rotation.clone(); obj.rotation.set(0,0,0); obj.updateMatrixWorld(); const localBox = new THREE.Box3().setFromObject(obj); const localSize = new THREE.Vector3(); localBox.getSize(localSize); localSize.multiplyScalar(0.95); const localCenter = new THREE.Vector3(); localBox.getCenter(localCenter); obj.rotation.copy(prevRot); obj.updateMatrixWorld(); const finalOBB = new OBB(); finalOBB.halfSize.copy(localSize).multiplyScalar(0.5); const offset = localCenter.clone().sub(obj.position); offset.applyEuler(obj.rotation); finalOBB.center.copy(obj.position).add(offset); finalOBB.rotation.setFromMatrix4(obj.matrixWorld); return finalOBB; }
    function checkCollisions() { if(!selectedObject||!selectedObject.userData.collides){isColliding=false; outlinePass.visibleEdgeColor.setHex(0xffff00); return;} const myOBB = getOBBFromObject(selectedObject); let h=false; for(let o of objectsInScene){ if(o!==selectedObject && o.userData.collides && !o.userData.isFloor){ if(o.position.distanceTo(selectedObject.position) > 10) continue; if (myOBB.intersectsOBB(getOBBFromObject(o))) { h=true; break; } } } isColliding=h; outlinePass.visibleEdgeColor.setHex(isColliding ? 0xff0000 : 0xffff00); if(!isColliding) updateUI(); }
    
    function toggleMeasureMode() { if(isDrawingFloor) toggleFloorMode(); isMeasuring=!isMeasuring; const b=document.getElementById('btn-measure'); if(isMeasuring){b.classList.add('active-tool');b.innerText="📏 Click A";deselectObject();}else{b.classList.remove('active-tool');b.innerText="📏 Medir";clearMeasurements();} }
    function clearMeasurements() { measurePoints=[]; measureMarkers.forEach(m=>scene.remove(m)); measureMarkers=[]; if(measureLine)scene.remove(measureLine); if(measureLabel)scene.remove(measureLabel); document.getElementById('clear-measures').style.display='none'; }
    function createMeasureMarker(p) { const m=new THREE.Mesh(new THREE.SphereGeometry(0.15),new THREE.MeshBasicMaterial({color:0xe67e22,depthTest:false})); m.position.copy(p); m.renderOrder=999; scene.add(m); measureMarkers.push(m); }
    function updateMeasureLine(e) { if(measurePoints.length<1)return; const s=measurePoints[0]; if(measureLine)scene.remove(measureLine); const g=new THREE.BufferGeometry().setFromPoints([s,e]); measureLine=new THREE.Line(g,new THREE.LineBasicMaterial({color:0xe67e22,linewidth:3,depthTest:false})); measureLine.renderOrder=998; scene.add(measureLine); const d=s.distanceTo(e).toFixed(2); const b=document.getElementById('btn-measure'); if(isMeasuring&&measurePoints.length===1)b.innerText=`📏 ${d}m`; if(measurePoints.length===2){createMeasureLabel(d+" m", s.clone().lerp(e,0.5).add(new THREE.Vector3(0,0.3,0))); document.getElementById('clear-measures').style.display='block'; b.innerText="📏 Terminar";} }
    function createMeasureLabel(t,p) { if(measureLabel)scene.remove(measureLabel); const c=document.createElement('canvas');c.width=256;c.height=128;const x=c.getContext('2d');x.fillStyle="rgba(0,0,0,0.7)";x.roundRect(10,10,236,108,20);x.fill();x.font="bold 60px Arial";x.fillStyle="white";x.textAlign="center";x.textBaseline="middle";x.fillText(t,128,64);const s=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthTest:false}));s.position.copy(p);s.scale.set(2,1,1);s.renderOrder=999;scene.add(s);measureLabel=s; }
    
    function clearFloorDraft() { floorPoints=[]; floorMarkers.forEach(m=>scene.remove(m)); floorMarkers=[]; if(floorLine)scene.remove(floorLine); if(floorLabel)scene.remove(floorLabel); document.getElementById('btn-close-floor').style.display='none'; document.getElementById('inp-dist').value=""; document.getElementById('inp-ang').value=""; }
    function updateFloorFromInput() { if (!isDrawingFloor || floorPoints.length === 0) return; const d = parseFloat(document.getElementById('inp-dist').value); const a = parseFloat(document.getElementById('inp-ang').value); if (!isNaN(d) && d > 0) { const last = floorPoints[floorPoints.length - 1]; let dir = new THREE.Vector3(1, 0, 0); if (floorPoints.length >= 2) { const prev = floorPoints[floorPoints.length - 2]; dir.subVectors(last, prev).normalize(); if (!isNaN(a)) dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), a * (Math.PI / 180)); } updateFloorDraft(last.clone().add(dir.multiplyScalar(d)), true); } }
    function updateFloorDraft(c, input=false) { if(floorPoints.length===0)return; if(floorLine)scene.remove(floorLine); const pts=[...floorPoints,c]; floorLine=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:0x9b59b6,linewidth:2})); scene.add(floorLine); const l=floorPoints[floorPoints.length-1],d=l.distanceTo(c).toFixed(2); let a=0; if(floorPoints.length>=2){const p=floorPoints[floorPoints.length-2];a=Math.round(new THREE.Vector3().subVectors(l,p).normalize().angleTo(new THREE.Vector3().subVectors(c,l).normalize())*(180/Math.PI));} if(!input&&!isInputFocused){document.getElementById('inp-dist').value=d;document.getElementById('inp-ang').value=a;} updateFloorInfoLabel(`${d}m`,c); if(floorPoints.length>=3)document.getElementById('btn-close-floor').style.display='block'; }
    function updateFloorInfoLabel(t,p) { if(floorLabel)scene.remove(floorLabel); const c=document.createElement('canvas');c.width=300;c.height=100;const x=c.getContext('2d');x.fillStyle="rgba(0,0,0,0.6)";x.roundRect(10,10,280,80,15);x.fill();x.font="bold 40px Arial";x.fillStyle="#fff";x.textAlign="center";x.textBaseline="middle";x.fillText(t,150,50);const m=new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthTest:false});floorLabel=new THREE.Sprite(m);floorLabel.position.copy(p).add(new THREE.Vector3(0,0.5,0));floorLabel.scale.set(3,1,1);floorLabel.renderOrder=999;scene.add(floorLabel); }
    function addPointFromInput() { if(isDrawingFloor){const d=parseFloat(document.getElementById('inp-dist').value),a=parseFloat(document.getElementById('inp-ang').value);if(!isNaN(d)&&d>0){const l=floorPoints.length>0?floorPoints[floorPoints.length-1]:new THREE.Vector3(0,0,0);let v=new THREE.Vector3(1,0,0);if(floorPoints.length>=2){const p=floorPoints[floorPoints.length-2];v.subVectors(l,p).normalize();if(!isNaN(a))v.applyAxisAngle(new THREE.Vector3(0,1,0),a*(Math.PI/180));}addFloorPoint(l.clone().add(v.multiplyScalar(d)));document.getElementById('inp-dist').value="";document.getElementById('inp-dist').focus();}else if(floorPoints.length===0)addFloorPoint(new THREE.Vector3(0,0,0));} }
    function addFloorPoint(p) { floorPoints.push(p); const m=new THREE.Mesh(new THREE.SphereGeometry(0.1,16,16),new THREE.MeshBasicMaterial({color:0x8e44ad}));m.position.copy(p);scene.add(m);floorMarkers.push(m); }
    function finishFloor() { if(floorPoints.length<3)return; let a=0;const n=floorPoints.length;for(let i=0;i<n;i++){const j=(i+1)%n;a+=floorPoints[i].x*floorPoints[j].z;a-=floorPoints[j].x*floorPoints[i].z;}a=Math.abs(a/2);const pr=Math.round(a*PRICE_PER_M2); const s=new THREE.Shape();s.moveTo(floorPoints[0].x,floorPoints[0].z);for(let i=1;i<floorPoints.length;i++)s.lineTo(floorPoints[i].x,floorPoints[i].z);s.lineTo(floorPoints[0].x,floorPoints[0].z); const m=new THREE.Mesh(new THREE.ExtrudeGeometry(s,{depth:0.05,bevelEnabled:false}),new THREE.MeshStandardMaterial({color:FLOOR_COLORS.garnet,roughness:0.5}));m.rotation.x=Math.PI/2;m.position.y=0.01;m.receiveShadow=true;m.castShadow=true; m.userData={price:pr,locked:false,collides:true,isFloor:true,area:a.toFixed(2),name:"Suelo Caucho",ref:"S-001",dims:`${a.toFixed(2)} m2`,points:floorPoints.map(p=>({x:p.x,y:p.y,z:p.z}))}; scene.add(m);objectsInScene.push(m);totalPrice+=pr;updateBudget();updateFloorInfoLabel(`Area: ${a.toFixed(2)}m²`,floorPoints[n-1]);setTimeout(()=>scene.remove(floorLabel),3000);clearFloorDraft(); saveHistory(); showToast('Suelo creado correctamente', 'success'); }
    function setFloorColor(h) { if(selectedObject&&selectedObject.userData.isFloor)selectedObject.material.color.setHex(h); saveHistory(); }
    
    function preloadLogo() { const i=new Image();i.crossOrigin="Anonymous";i.src=LOGO_URL;i.onload=()=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;c.getContext('2d').drawImage(i,0,0);loadedLogoImg=i;loadedLogoBase64=c.toDataURL('image/png');};i.onerror=()=>{loadedLogoBase64=createLogoUrl();}; }
    function createLogoUrl() { const c=document.createElement('canvas');c.width=200;c.height=50;const x=c.getContext('2d');x.font="bold 40px Arial";x.fillStyle="#4a90e2";x.fillText("Levipark21",0,40);return c.toDataURL('image/png'); }
    function wait(ms) { return new Promise(r=>setTimeout(r,ms)); }
    function toggleDisplay(id) { const e=document.getElementById(id);e.style.display=e.style.display==='none'?'block':'none'; }
    function takeScreenshot() { transformControl.detach(); outlinePass.selectedObjects=[]; composer.render(); const d=renderer.domElement.toDataURL('image/jpeg',0.9); const a=document.createElement('a'); a.download='diseño.jpg'; a.href=d; a.click(); if(selectedObject) selectObject(selectedObject); showToast("Captura guardada", 'success'); }
    function setView(v) { controls.target.set(0,0,0); const d=20; if(v==='iso')activeCamera.position.set(d,d,d); if(v==='top')activeCamera.position.set(0,d,0); if(v==='front')activeCamera.position.set(0,0,d); if(v==='side')activeCamera.position.set(d,0,0); activeCamera.lookAt(0,0,0); controls.update(); }
    function cloneSelected() { if (!selectedObject || selectedObject.userData.isFloor) return; const original = selectedObject; const clone = original.clone(); clone.position.add(new THREE.Vector3(1, 0, 1)); clone.userData = JSON.parse(JSON.stringify(original.userData)); scene.add(clone); objectsInScene.push(clone); totalPrice += clone.userData.price || 0; updateBudget(); selectObject(clone); snapToFloor(clone); checkCollisions(); saveHistory(); showToast("Objeto clonado", 'success'); }
    function placeObject(p) { document.getElementById('loading').style.display='block'; const u=productToPlace; const b64=pendingModelBase64; loader.load(u, (g)=>{ const m=g.scene; m.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}}); processSafetyZones(m); m.position.set(p.x,0,p.z); m.userData=JSON.parse(JSON.stringify(window.currentProductData)); m.userData.modelFile=u; m.userData.modelBase64=b64; m.userData.locked=false; m.userData.collides=true; scene.add(m); objectsInScene.push(m); totalPrice+=m.userData.price; updateBudget(); selectObject(m); snapToFloor(m); saveHistory(); document.getElementById('loading').style.display='none'; productToPlace=null; pendingModelBase64=null; document.querySelectorAll('.btn-product').forEach(btn=>btn.classList.remove('active')); showToast("Objeto colocado", 'success'); }); }
    function onWindowResize() { const w=window.innerWidth, h=window.innerHeight; perspectiveCamera.aspect=w/h; perspectiveCamera.updateProjectionMatrix(); renderer.setSize(w,h); composer.setSize(w,h); }
    function render(timestamp, frame) { controls.update(); if (renderer.xr.isPresenting) renderer.render(scene, activeCamera); else composer.render(); }
    function setGizmoMode(m) { 
        transformControl.setMode(m); 
        const t=document.getElementById('mode-translate');
        const r=document.getElementById('mode-rotate');
        const s=document.getElementById('mode-scale');
        
        // Reset styles
        [t,r,s].forEach(b => {
            b.classList.remove('active-mode');
            b.style.background='#444';
            b.style.color='#ccc';
        });

        // Set active
        let active;
        if(m==='translate') active = t;
        else if(m==='rotate') active = r;
        else if(m==='scale') active = s;
        
        if(active){
            active.classList.add('active-mode');
            active.style.background='#4a90e2';
            active.style.color='white';
        }
    }
    function toggleProjection() { const p=activeCamera.position.clone(), t=controls.target.clone(); activeCamera = (activeCamera===perspectiveCamera)?orthoCamera:perspectiveCamera; activeCamera.position.copy(p); activeCamera.lookAt(t); controls.object=activeCamera; transformControl.camera=activeCamera; if (activeCamera === orthoCamera) { const aspect = window.innerWidth / window.innerHeight; orthoCamera.left = -20 * aspect; orthoCamera.right = 20 * aspect; orthoCamera.top = 20; orthoCamera.bottom = -20; orthoCamera.updateProjectionMatrix(); } composer.passes.forEach(pass => { if(pass.camera) pass.camera = activeCamera; }); document.getElementById('btn-projection').innerText = (activeCamera===perspectiveCamera)?"👁️ Perspectiva":"📐 Ortográfica"; }

    async function generateDossier() {
        const ref=await askUser("Nombre del Proyecto:", "Nuevo Parque"); 
        if(!ref)return;
        const discStr=await askUser("Descuento (%):", "0");
        const disc=parseFloat(discStr)||0;
        
        try {
            document.getElementById('loading').style.display='block';
            updateLoadingText("Generando PDF...");
            const doc=new window.jspdf.jsPDF(); 
            const w=doc.internal.pageSize.getWidth(), h=doc.internal.pageSize.getHeight(), m=10;

            const prevSky = sky.visible; 
            const prevBG = scene.background; 
            
            sky.visible = false; 
            scene.background = new THREE.Color(0xffffff); 
            outlinePass.selectedObjects = []; 
            transformControl.detach();
            
            // SOMBRAS ON PARA PORTADA
            dirLight.castShadow = true;
            
            updateLoadingText("Portada..."); await wait(200);
            const originalSize = new THREE.Vector2(); renderer.getSize(originalSize);
            renderer.setSize(2000, 1500); 
            activeCamera.aspect = 2000 / 1500; activeCamera.updateProjectionMatrix();
            renderer.render(scene, activeCamera); 
            const imgCov = renderer.domElement.toDataURL('image/jpeg', 0.9);
            
            renderer.setSize(originalSize.x, originalSize.y); 
            activeCamera.aspect = originalSize.x / originalSize.y; activeCamera.updateProjectionMatrix();

            // SOMBRAS OFF PARA PLANOS
            dirLight.castShadow = false;

            updateLoadingText("Vistas Técnicas..."); controls.enabled=false;
            const oldCam = activeCamera; activeCamera = orthoCamera; const views={}; 
            
            const box=new THREE.Box3(); 
            if(objectsInScene.length>0) objectsInScene.forEach(o=>box.expandByObject(o)); 
            else box.setFromCenterAndSize(new THREE.Vector3(0,0,0), new THREE.Vector3(10,10,10));
            const ctr=box.getCenter(new THREE.Vector3()), sz=box.getSize(new THREE.Vector3());
            const maxDim=Math.max(sz.x,sz.y,sz.z)*0.6, dist=maxDim*4;
            
            orthoCamera.zoom=1; orthoCamera.left=-maxDim; orthoCamera.right=maxDim; orthoCamera.top=maxDim; orthoCamera.bottom=-maxDim; orthoCamera.updateProjectionMatrix();

            const camPos=[{n:'front',p:[0,0,dist],u:[0,1,0]}, {n:'side',p:[dist,0,0],u:[0,1,0]}, {n:'top',p:[0,dist,0],u:[0,0,-1]}, {n:'iso',p:[dist,dist,dist],u:[0,1,0]}];
            
            renderer.setSize(1000, 1000);
            for(let c of camPos) {
                orthoCamera.position.set(ctr.x+c.p[0], ctr.y+c.p[1], ctr.z+c.p[2]); 
                orthoCamera.up.set(c.u[0],c.u[1],c.u[2]); orthoCamera.lookAt(ctr);
                renderer.render(scene, orthoCamera); 
                views[c.n]=renderer.domElement.toDataURL('image/jpeg',0.9); 
                await wait(100); 
            }
            renderer.setSize(originalSize.x, originalSize.y);

            const items=[], seen=new Set(); 
            objectsInScene.forEach(o=>o.visible=false); 
            renderer.setSize(800, 600);
            
            for(let o of objectsInScene) {
                if(seen.has(o.userData.ref)) continue; seen.add(o.userData.ref);
                updateLoadingText("Item: "+o.userData.name); 
                o.visible=true; 
                
                const b=new THREE.Box3().setFromObject(o); const c=b.getCenter(new THREE.Vector3()); const s=b.getSize(new THREE.Vector3()); const d=Math.max(s.x,s.y,s.z)*0.6;
                orthoCamera.position.set(15,15,15); orthoCamera.up.set(0,1,0); orthoCamera.lookAt(c);
                orthoCamera.left=-d*1.33; orthoCamera.right=d*1.33; orthoCamera.top=d; orthoCamera.bottom=-d; orthoCamera.updateProjectionMatrix();
                
                renderer.render(scene, orthoCamera);
                
                let fImg=renderer.domElement.toDataURL('image/jpeg',0.9);
                if(o.userData.img_2d && !o.userData.img_2d.startsWith('data:')){ 
                    try {
                        const i=new Image(); i.src=o.userData.img_2d; 
                        await new Promise((resolve, reject) => {
                             i.onload = resolve; i.onerror = resolve; 
                             setTimeout(resolve, 500); 
                        });
                        if(i.width>0){
                            const ca=document.createElement('canvas');ca.width=i.width;ca.height=i.height;ca.getContext('2d').drawImage(i,0,0);
                            fImg=ca.toDataURL('image/jpeg',0.9);
                        }
                    } catch(e){} 
                }
                
                items.push({d:o.userData, i:fImg}); 
                o.visible=false; 
                await wait(50);
            }
            renderer.setSize(originalSize.x, originalSize.y);

            dirLight.castShadow = true;
            objectsInScene.forEach(o=>o.visible=true); 
            sky.visible=prevSky; scene.background=prevBG; 
            if(selectedObject) selectObject(selectedObject);
            activeCamera=oldCam; controls.enabled=true;
            
            updateLoadingText("Generando PDF...");
            const lg = loadedLogoBase64 || createLogoUrl(); 
            const date = new Date().toLocaleDateString(); 
            const BLUE = [74, 144, 226];

            doc.setFont("helvetica", "bold"); doc.setFontSize(30); doc.setTextColor(40); doc.text("Levipark21", m, 25); 
            doc.setFontSize(14); doc.setTextColor(100); doc.text(ref, w-m, 25, {align:'right'});
            const coverProp = doc.getImageProperties(imgCov); 
            const maxCoverH = (h/2) + 20; const maxCoverW = w - (2*m); 
            const coverRatio = Math.min(maxCoverW / coverProp.width, maxCoverH / coverProp.height);
            doc.addImage(imgCov, 'JPEG', m + (maxCoverW - coverProp.width*coverRatio)/2, 40, coverProp.width*coverRatio, coverProp.height*coverRatio); 
            addFooter(doc, date, lg);

            doc.addPage(); doc.setFontSize(16); doc.setTextColor(0); doc.text("Vistas Técnicas", m, 20);
            const gw=(w-30)/2, gh=(h-60)/2; 
            const putView = (img, tit, x, y) => { doc.setFontSize(12); doc.setTextColor(100); doc.text(tit, x, y-2); const props = doc.getImageProperties(img); const r = Math.min(gw/props.width, gh/props.height); const fw = props.width * r; const fh = props.height * r; doc.addImage(img, 'JPEG', x+(gw-fw)/2, y+(gh-fh)/2, fw, fh); };
            putView(views.front, "Alzado", 10, 30); putView(views.side, "Perfil", 20+gw, 30); 
            putView(views.top, "Planta", 10, 40+gh); putView(views.iso, "Isométrica", 20+gw, 40+gh); 
            addFooter(doc, date, lg);

            doc.addPage(); doc.setFontSize(18); doc.text("Presupuesto", m, 20);
            const rows = objectsInScene.map(o => [o.userData.name, o.userData.ref, "1", (o.userData.price||0).toLocaleString()+" €"]);
            const tot=totalPrice, dAm=tot*(disc/100), fin=tot-dAm, iva=fin*0.21, final=fin+iva;
            rows.push(["","","",""], ["","","Dto "+disc+"%", "-"+dAm.toLocaleString()+" €"], ["","","Base", fin.toLocaleString()+" €"], ["","","IVA 21%", iva.toLocaleString()+" €"], ["","","TOTAL", final.toLocaleString()+" €"]);
            doc.autoTable({head:[['Concepto','Ref','Ud','Precio']], body:rows, startY:30, theme:'grid', headStyles:{fillColor:BLUE}, columnStyles:{3:{halign:'right'}}}); 
            addFooter(doc, date, lg);

            if(items.length>0){
                doc.addPage(); doc.setFontSize(24); doc.text("Documentación", w/2, h/2, {align:'center'});
                items.forEach(i => {
                    doc.addPage(); addHeader(doc, ref); 
                    const iProp = doc.getImageProperties(i.i); const maxH = (h/2)-20; const maxW = w-2*m; const r = Math.min(maxW/iProp.width, maxH/iProp.height);
                    doc.addImage(i.i, 'JPEG', m+(maxW-iProp.width*r)/2, 20, iProp.width*r, iProp.height*r);
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
            
            doc.save("Dossier_"+ref+".pdf");
            showToast("PDF generado correctamente", 'success');

        } catch (err) {
            console.error(err);
            showMessage("Error", "Error al generar PDF: " + err.message);
        } finally {
            document.getElementById('loading').style.display='none';
            dirLight.castShadow = true;
            controls.enabled = true;
            activeCamera = perspectiveCamera;
            objectsInScene.forEach(o=>o.visible=true); 
            sky.visible = true;
            if(selectedObject) selectObject(selectedObject);
        }
    }
    
    function addHeader(d,r) { d.setFontSize(10);d.setTextColor(150);d.text(r,d.internal.pageSize.getWidth()-20,15,{align:'right'}); }
    function addFooter(d,dt,lg) { const w=d.internal.pageSize.getWidth(),h=d.internal.pageSize.getHeight();d.setFontSize(10);d.setTextColor(150);d.text(dt,20,h-15);if(lg){const r=loadedLogoImg?loadedLogoImg.width/loadedLogoImg.height:4;let lw=40,lh=lw/r;if(lh>15){lh=15;lw=lh*r;}d.addImage(lg,'PNG',w-10-lw,h-25,lw,lh);} }

    function toggleGrid() {
        if(!gridHelper) return;
        gridHelper.visible = !gridHelper.visible;
        const btn = document.getElementById('btn-toggle-grid');
        if(gridHelper.visible) {
            btn.classList.add('active-grid');
            showToast('Cuadrícula visible (1x1m)', 'info');
        } else {
            btn.classList.remove('active-grid');
        }
    }

    function filterCatalog(text) {
        text = text.toLowerCase();
        const container = document.getElementById('dynamic-catalog');
        const select = document.getElementById('line-select');
        
        if (text.trim() === "") {
            // Si está vacío, volvemos a mostrar la categoría seleccionada actualmente
            renderCategories(select.value);
            return;
        }

        container.innerHTML = "";
        let found = false;

        // Buscamos en TODAS las líneas y categorías
        for (const [lineName, categories] of Object.entries(productsDB)) {
            for (const [catName, products] of Object.entries(categories)) {
                
                // Filtramos productos que coincidan
                const matches = products.filter(p => p.name.toLowerCase().includes(text) || p.ref.toLowerCase().includes(text));
                
                if (matches.length > 0) {
                    found = true;
                    // Creamos un "falso" acordeón para mostrar resultados
                    const header = document.createElement('div');
                    header.className = "accordion-btn active-acc"; // Estilo fijo abierto
                    header.innerText = `${lineName} - ${catName}`;
                    header.style.cursor = "default";
                    
                    const pPanel = document.createElement('div');
                    pPanel.className = "panel-products";
                    pPanel.style.maxHeight = "1000px"; // Forzamos abierto

                    matches.forEach(prod => {
                        const bb = document.createElement('button');
                        bb.className = "btn-product";
                        bb.innerHTML = `${prod.name} <span style="float:right;opacity:0.7">${prod.price}€</span>`;
                        bb.onclick = () => {
                            prepareToPlace(prod, bb);
                            if(window.innerWidth < 600) document.getElementById('ui-panel').style.display='none';
                        };
                        pPanel.appendChild(bb);
                    });

                    container.appendChild(header);
                    container.appendChild(pPanel);
                }
            }
        }

        if (!found) {
            container.innerHTML = "<div style='color:#aaa; text-align:center; padding:10px;'>No se encontraron productos.</div>";
        }
    }

    function updateAndShowList() {
        const container = document.getElementById('list-content');
        container.innerHTML = "";
        
        if (objectsInScene.length === 0) {
            container.innerHTML = "<p style='color:#aaa; text-align:center;'>El proyecto está vacío.</p>";
        } else {
            // Agrupar items por referencia o nombre para contar duplicados?
            // De momento, listado simple para poder borrar individualmente.
            objectsInScene.forEach((obj, index) => {
                const row = document.createElement('div');
                row.className = 'list-item-row';
                
                const nameDiv = document.createElement('div');
                nameDiv.className = 'list-item-name';
                // Icono según tipo
                const icon = obj.userData.isFloor ? '⬛' : '🌳';
                nameDiv.innerText = `${icon} ${obj.userData.name} (${obj.userData.ref})`;
                
                const priceDiv = document.createElement('div');
                priceDiv.className = 'list-item-price';
                priceDiv.innerText = (obj.userData.price || 0) + "€";

                const delBtn = document.createElement('button');
                delBtn.className = 'btn-delete-item';
                delBtn.innerText = '🗑️';
                delBtn.title = "Eliminar elemento";
                delBtn.onclick = () => {
                    // Eliminar objeto específico
                    if(!obj.userData.locked) {
                        selectObject(obj); // Seleccionar para asegurar lógica
                        deleteSelected();  // Usar la función existente
                        updateAndShowList(); // Refrescar lista
                    } else {
                        showToast("Elemento bloqueado. Desbloquéalo primero.", 'error');
                    }
                };

                row.appendChild(nameDiv);
                row.appendChild(priceDiv);
                row.appendChild(delBtn);
                container.appendChild(row);
            });
        }

        document.getElementById('list-total-price').innerText = totalPrice.toLocaleString('es-ES') + " €";
        document.getElementById('list-modal').style.display = 'flex';
    }

} catch (e) { alert("Error Crítico: " + e.message); }