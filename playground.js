//-------------------------------------------------------------------------------------------------
// elements
//-------------------------------------------------------------------------------------------------

let screen = document.getElementById("playground-screen");
let loading = document.getElementById("playground-loading");
let errorMsg = document.getElementById("playground-error-msg");
let errorTitle = document.getElementById("playground-error-title");
let errorText = document.getElementById("playground-error-text");
let intro = document.getElementById("playground-intro");
let canvas = document.querySelector("#playground-screen canvas");

let ctx = canvas.getContext("2d", {
	alpha: false,
	desynchronized: true
});


//-------------------------------------------------------------------------------------------------
// states
//-------------------------------------------------------------------------------------------------

/*
this toplevel state machine only really controls the visibility of html elements. there's quite a 
lot of implicit state related to loading and rendering - see below.

possible states are "preLoading", "loading", "errorMsg", "intro" or "rendering". 

"preLoading" is a brief pause, to avoid a distracting flicker of "Loading..." text on fast connections.
*/

let state = "preLoading";

function showElementsForState(newState) {
	//hide/disable everything
	screen.style.display = "none";
	loading.style.display = "none";
	errorMsg.style.display = "none";
	intro.style.display = "none";
	canvas.style.display = "none";

	//selectively re-show/re-enable only what the new state needs
	switch (newState) {
		case "loading":
			screen.style.display = "flex";
			loading.style.display = "block";
			break;

		case "errorMsg":
			screen.style.display = "flex";
			errorMsg.style.display = "flex";
			break;

		case "intro":
			screen.style.display = "flex";
			intro.style.display = "flex";
			break;

		case "rendering":
			screen.style.display = "flex";
			canvas.style.display = "block";
			break;

		default:
			throw new Error("unrecognized state " + newState)
	}

	//update the `state` global
	state = newState
}

screen.addEventListener("click", (ev) => {
	if (state == "intro") {
		showElementsForState("rendering");
		startRendering();
	}
});

screen.addEventListener("contextmenu", (ev) => {
	ev.preventDefault();
});

document.addEventListener("keydown", (ev) => {
	if (state == "intro") {
		showElementsForState("rendering");
		startRendering();
	}
});


//-------------------------------------------------------------------------------------------------
// the "preLoading" state
//-------------------------------------------------------------------------------------------------

//think of this state as a child of the "loading" state. it calls startLoading when it's
//enabled and stopLoading when it's interrupted.

let preLoadingTimeout = null;

window.setTimeout(function() {
	startLoading();

	if (!loaded) {
		preLoadingTimeout = window.setTimeout(preLoad, 150);
	}
}, 0);

function isPreLoading() {
	return (preLoadingTimeout !== null);
}

function preLoad() {
	preLoadingTimeout = null;
	showElementsForState("loading");
}

function stopPreLoading() {
	window.clearTimeout(preLoadingTimeout);
	preLoadingTimeout = null;

	//there actually isn't any way to cancel a Promise in ES6... but the worst-case scenario
	//is that `bitmap` gets loaded twice, which isn't the end of the world.

	//we just set the `loadCancelled` flag to prevent onLoaded from being executed.
	loadCancelled = true;
}


//-------------------------------------------------------------------------------------------------
// the "loading" state
//-------------------------------------------------------------------------------------------------

//the actual data is only loaded once. if `loaded` is true, then the data has already been loaded, 
//and startLoading() can immediately cancel itself (and "preLoading") and enable the
//rendering state instead.

let loaded = false;
let bitmap = null;

//important never to load the .wasm file twice, even if some other part of loading failed
let wasmLoaded = false;

function startLoading() {
	loadCancelled = false;

	if (loaded) {
		onLoaded();
	} else {
		let bitmapPromise = new Promise((resolve, reject) => {
			bitmap = new Image();
			bitmap.addEventListener("load", () => {
				resolve();
			});
			bitmap.addEventListener("error", (err) => {
				reject("unable to load font bitmap: ", err.type);
			});
			bitmap.src = "monogram.gif";
		});

		let wasmPromise = new Promise((resolve, reject) => {
			window.fetch("glsp_playground_bg.wasm").then(
				response => {
					if (!response.ok) {
						throw Error(response.statusText);
					}

					const reader = response.clone().body.getReader();
					const contentLength = +response.headers.get("Content-Length");
					let receivedLength = 0;
					const readerPromise = () => new Promise((resolve, reject) =>
						reader.read().then(result => {

							receivedLength += (result.value||0).length;

							document.getElementById("playground-progress").style.width = (100 * receivedLength / contentLength) + "%";

							resolve(result.done ? null : readerPromise());
						})
					);

					Promise.all([readerPromise().then(() => response.arrayBuffer()).then(
						arrayBuffer => {
							if (wasmLoaded) {
								resolve();
							} else {
								wasm_bindgen(arrayBuffer).then(
									() => {
										wasmLoaded = true;
										resolve();
									},
									(err) => reject(err)
								);
							}
						},
						err => reject(err)
					)]);
				},
				err => reject(err)
			);
		});

		Promise.all([bitmapPromise, wasmPromise])
			.then(onLoaded)
			.catch(onLoadFailed);
	}
}

let loadCancelled = false;

function onLoaded() {
	if (loadCancelled) {
		return;
	}

	//book-keeping
	loaded = true;
	console.assert(bitmap !== null && wasmLoaded);

	if (isPreLoading()) {
		stopPreLoading();
		loadCancelled = false;
	}

	//load the glsp code, then show the "intro" screen
	try {
		wasm_bindgen.initEngine(Math.random());
	} catch(err) {
		showErrorMsg(err);
		return;
	}

	intro.innerHTML =
		"<h2>" + wasm_bindgen.title() + "</h2>" + wasm_bindgen.blurb() +
		"<p>To begin, click the play area or press any key." +
		"<div class=\"strut\"></div>";

	showElementsForState("intro");
}

function onLoadFailed(err) {
	loaded = false;
	bitmap = null;

	if (isPreLoading()) {
		stopPreLoading();
		loadCancelled = false;
	}

	showErrorMsg(err);
}


//-------------------------------------------------------------------------------------------------
// the "errorMsg" state
//-------------------------------------------------------------------------------------------------

function showErrorMsg(err) {
	errorText.innerText = String(err);

	showElementsForState("errorMsg")
}


//-------------------------------------------------------------------------------------------------
// the "rendering" state
//-------------------------------------------------------------------------------------------------

let animationFrameHandle = null;
let bufWidth = canvas.width;
let bufHeight = canvas.height;
let screenWidth = bufWidth;
let screenHeight = bufHeight;

function resizeCanvas() {
	//bufWidth and bufHeight store the nominal size of the "back buffer", as specified by
	//the glsp code using the play:width and play:height globals.

	//this function applies a width, height and image-rendering strategy for the <canvas> element,
	//based on the size of the rendering area in device pixels. if it can be upscaled to an
	//integer ratio of its nominal size, while still occuping at least two-thirds of the
	//rendering area in at least one dimension, we perform that integer upscaling using
	//image-rendering: crisp-edges. otherwise we upscale to the next-lowest integer ratio using
	//2d transforms, and upscale or downscale the rest of the way using html.

	let padding = 16 * window.devicePixelRatio;
	screenWidth = screen.clientWidth * window.devicePixelRatio;
	screenHeight = screen.clientHeight * window.devicePixelRatio;

	let maxWidth = screenWidth - padding*2;
	let maxHeight = screenHeight - padding*2;

	let floatRatio = Math.min(maxWidth / bufWidth, maxHeight / bufHeight);
	let intRatio = Math.floor(floatRatio);

	let drawScale;

	if (intRatio >= 1 && intRatio/floatRatio >= 0.667) {
		//image-rendering: pixelated is pretty broken on Chrome right now, so we fall back to 
		//just using imageSmoothingEnabled and enlarging the canvas
		let isChrome = !CSS.supports("image-rendering", "crisp-edges");

		if (isChrome) {
			drawScale = Math.max(1, intRatio);

			canvas.width = bufWidth * drawScale;
			canvas.height = bufHeight * drawScale;

			canvas.style.imageRendering = "auto";
		} else {
			drawScale = 1;

			canvas.width = bufWidth;
			canvas.height = bufHeight;

			canvas.style.imageRendering = "crisp-edges";
		}

		canvas.style.width = (bufWidth * intRatio / window.devicePixelRatio).toFixed(2) + "px";
		canvas.style.height = (bufHeight * intRatio / window.devicePixelRatio).toFixed(2) + "px";
	} else {
		drawScale = Math.max(1, intRatio);

		canvas.width = bufWidth * drawScale;
		canvas.height = bufHeight * drawScale;

		canvas.style.width = (bufWidth * floatRatio / window.devicePixelRatio).toFixed(2) + "px";
		canvas.style.height = (bufHeight * floatRatio / window.devicePixelRatio).toFixed(2) + "px";
		canvas.style.imageRendering = "auto";
	}

	//drawing configuration is reset when the canvas' backing width/height changes, so we
	//need to assign any long-lasting settings here
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.scale(drawScale, drawScale);
	ctx.imageSmoothingEnabled = false;
}

function startRendering() {
	showElementsForState("rendering");

	bufWidth = wasm_bindgen.width();
	bufHeight = wasm_bindgen.height();
	resizeCanvas();

	//start the animation loop
	animationFrameHandle = window.requestAnimationFrame(onFirstFrame);
}

function stopRendering() {
	if (animationFrameHandle !== null) {
		window.cancelAnimationFrame(animationFrameHandle);
		animationFrameHandle = null;
	}
}

//the input map. each key is "LMB", "RMB", "MMB" or a KeyboardEvent.key string. each value is
//a table with keys `down`, `pressed` and `released` bound to booleans. we assume that if a
//particular key hasn't been seen, all three values are false.
let inputState = {};

let mouseClientX = 0;
let mouseClientY = 0;

document.addEventListener("mousemove", (ev) => {
	mouseClientX = ev.clientX;
	mouseClientY = ev.clientY;
});

//returned coordinates are relative to the interior of the <canvas> element, and measured in 
//back-buffer pixels, as in bufWidth and bufHeight. this function shouldn't be called when
//the canvas is hidden.
function mouseCoords() {
	let rect = canvas.getBoundingClientRect();

	return {
		x: Math.floor((mouseClientX - rect.left) * (bufWidth / rect.width)),
		y: Math.floor((mouseClientY - rect.top) * (bufHeight / rect.height))
	}
}

function inputEntry(key) {
	//we normalize alphabetic characters to uppercase
	if (key.length == 1 && key >= "a" && key <= "z") {
		key = key.toUpperCase();
	}

	if (!(key in inputState)) {
		inputState[key] = { down: false, pressed: false, released: false };
	}

	return inputState[key];
}

function stepInputState() {
	for (key of Object.keys(inputState)) {
		inputState[key].pressed = false;
		inputState[key].released = false;
	}
}

document.addEventListener("keydown", (ev) => {
	if (ev.key != "Undefined" && !ev.repeat) {
		let entry = inputEntry(ev.key);
		entry.down = true;
		entry.pressed = true;
	}
});

document.addEventListener("keyup", (ev) => {
	if (ev.key != "Undefined") {
		let entry = inputEntry(ev.key);
		entry.down = false;
		entry.released = true;
	}
});

document.addEventListener("mousedown", (ev) => {
	let buttonName = ["LMB", "MMB", "RMB"][ev.button];
	if (!buttonName) {
		return;
	}

	let entry = inputEntry(buttonName);
	entry.down = true;
	entry.pressed = true;
});

document.addEventListener("mouseup", (ev) => {
	let buttonName = ["LMB", "MMB", "RMB"][ev.button];
	if (!buttonName) {
		return;
	}

	let entry = inputEntry(buttonName);
	entry.down = false;
	entry.released = true;
});

let lastTimeStamp = 0;

//to ensure that the `dt` argument is always accurate, we discard the first frame. this also
//helps to ensure that (play:pressed?) and (play:released?) are false during the first frame.
function onFirstFrame(timeStamp) {
	stepInputState();
	lastTimeStamp = timeStamp;
	animationFrameHandle = window.requestAnimationFrame(onAnimationFrame);
}

function onAnimationFrame(timeStamp) {

	//detect when the viewport has been resized, and resize the canvas if so
	let curScreenWidth = screen.clientWidth * window.devicePixelRatio;
	let curScreenHeight = screen.clientHeight * window.devicePixelRatio;
	if (screenWidth != curScreenWidth || screenHeight != curScreenHeight) {
		resizeCanvas();
	}

	//yield to glsp
	try {
		wasm_bindgen.update((timeStamp - lastTimeStamp)/1000);
	} catch(err) {
		stopRendering();
		showErrorMsg(err);
		return null;
	}

	//continue the main loop
	stepInputState();
	lastTimeStamp = timeStamp;
	animationFrameHandle = window.requestAnimationFrame(onAnimationFrame);
}


//-------------------------------------------------------------------------------------------------
// `play:` callbacks for glsp
//-------------------------------------------------------------------------------------------------

function playMouseX() {
	return mouseCoords().x;
}

function playMouseY() {
	return mouseCoords().y;
}

//to keep things minimalist, we only support querying the following symbols: lmb, mmb, rmb, 
//a through z, up, down, left, right, space, enter.
let knownInputs = {
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	space: " ",
	enter: "Enter",
	lmb: "LMB",
	mmb: "MMB",
	rmb: "RMB"
};

let simpleInputs = [
	"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
	"n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
];

for (simple of simpleInputs) {
	knownInputs[simple] = simple.toUpperCase();
}

function playDownP(input) {
	if (!(input in knownInputs)) {
		throw "unrecognized input " + input + " passed to play:down?"
	}

	return inputEntry(knownInputs[input]).down;
}

function playPressedP(input) {
	if (!(input in knownInputs)) {
		throw "unrecognized input " + input + " passed to play:pressed?"
	}

	return inputEntry(knownInputs[input]).pressed;
}

function playReleasedP(input) {
	if (!(input in knownInputs)) {
		throw "unrecognized input " + input + " passed to play:released?"
	}

	return inputEntry(knownInputs[input]).released;
}

function playFill(x, y, width, height, r, g, b) {
	x = Math.round(x);
	y = Math.round(y);
	width = Math.round(width);
	height = Math.round(height);
	r = Math.max(0, Math.min(255, Math.round(r)));
	g = Math.max(0, Math.min(255, Math.round(g)));
	b = Math.max(0, Math.min(255, Math.round(b)));

	ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
	ctx.fillRect(x, y, width, height);
}

function playDraw(char, dx, dy) {
	dx = Math.round(dx);
	dy = Math.round(dy);

	let x = char % 16, y = (char-x)/16-2;
	let w = 6, h = 10;

	ctx.drawImage(bitmap, x*w, y*h, w, h, dx, dy, w, h);
}

function playSound(name) {
	new Audio(name + ".mp3").play();
}
