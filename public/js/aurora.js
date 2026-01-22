/**
 * Veil - Aurora 背景动画
 * 登录页面的动态背景效果
 */

let canvas = null;
let ctx = null;
let width = 0;
let height = 0;
let blobs = [];
let animationFrameId = null;

class Blob {
    constructor() {
        this.init();
    }

    init() {
        this.x = Math.random() * width;
        this.y = Math.random() * height;
        this.vx = (Math.random() - 0.5) * 0.2;
        this.vy = (Math.random() - 0.5) * 0.2;
        this.radius = Math.min(width, height) * (0.5 + Math.random() * 0.3);
        const colors = ['#60A5FA', '#3B82F6', '#0EA5E9', '#2DD4BF', '#A5F3FC'];
        this.color = colors[Math.floor(Math.random() * colors.length)];
        this.alpha = 0;
        this.targetAlpha = 0.4 + Math.random() * 0.2;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;

        if (this.x < -this.radius) this.x = width + this.radius;
        if (this.x > width + this.radius) this.x = -this.radius;
        if (this.y < -this.radius) this.y = height + this.radius;
        if (this.y > height + this.radius) this.y = -this.radius;

        if (this.alpha < this.targetAlpha) this.alpha += 0.003;
    }

    draw() {
        ctx.beginPath();
        const gradient = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.radius);
        gradient.addColorStop(0, this.color + Math.floor(this.alpha * 255).toString(16).padStart(2, '0'));
        gradient.addColorStop(1, this.color + '00');
        ctx.fillStyle = gradient;
        ctx.rect(0, 0, width, height);
        ctx.fill();
    }
}

function initCanvas() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
    blobs = [];
    for (let i = 0; i < 6; i++) {
        blobs.push(new Blob());
    }
}

function animate() {
    if (document.body.classList.contains('app-mode')) return;

    ctx.fillStyle = '#F5F5F7';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'hard-light';
    blobs.forEach(blob => {
        blob.update();
        blob.draw();
    });
    ctx.globalCompositeOperation = 'source-over';
    animationFrameId = requestAnimationFrame(animate);
}

export function startAurora(canvasId = 'aurora-canvas') {
    canvas = document.getElementById(canvasId);
    if (!canvas) return;

    ctx = canvas.getContext('2d');
    initCanvas();
    animate();

    window.addEventListener('resize', initCanvas);
}


// ============================================
// 3D 卡片效果
// ============================================
let card = null;
let targetRotateX = 0;
let targetRotateY = 0;
let currentRotateX = 0;
let currentRotateY = 0;
let cardAnimationId = null;

function animateCard() {
    if (document.body.classList.contains('app-mode')) {
        cardAnimationId = null;
        return;
    }

    const ease = 0.06;
    currentRotateX += (targetRotateX - currentRotateX) * ease;
    currentRotateY += (targetRotateY - currentRotateY) * ease;
    card.style.transform = `rotateY(${currentRotateY}deg) rotateX(${currentRotateX}deg)`;
    cardAnimationId = requestAnimationFrame(animateCard);
}

export function initCard3D(cardId = 'loginCard') {
    card = document.getElementById(cardId);
    if (!card) return;

    document.addEventListener('mousemove', (e) => {
        if (document.body.classList.contains('app-mode')) return;
        targetRotateY = (window.innerWidth / 2 - e.pageX) / 30;
        targetRotateX = (window.innerHeight / 2 - e.pageY) / 30;
    });

    animateCard();
}
