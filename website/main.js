/* ============================================================
   TermFlow promo — interactions
   ------------------------------------------------------------
   DOWNLOAD LINKS: set these to wherever you host the binaries.
   Two options:
   1) GitHub Releases (recommended — no Vercel size limit):
      create a release and point these at the asset URLs, e.g.
      https://github.com/palamut62/termflow/releases/download/v0.2.2/TermFlow-0.2.2-x64.exe
   2) Self-host on Vercel: drop the files in website/public/download/
      and use "./download/TermFlow-0.2.2-x64.exe"
   ============================================================ */
const DOWNLOADS = {
  installer: 'https://zomlia6emkmpi3hi.public.blob.vercel-storage.com/TermFlow-0.2.2-x64.exe'
}

// Wire download buttons
const inst = document.getElementById('dl-installer')
const heroDl = document.getElementById('hero-download')
if (inst) inst.href = DOWNLOADS.installer
// Hero "Download" scrolls to the section; the actual file links live there.

// Year
document.getElementById('year').textContent = new Date().getFullYear()

// Sticky nav shadow
const nav = document.getElementById('nav')
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8)
onScroll()
window.addEventListener('scroll', onScroll, { passive: true })

// Mobile menu
const burger = document.getElementById('burger')
burger?.addEventListener('click', () => document.body.classList.toggle('menu-open'))
document.querySelectorAll('.nav__links a').forEach((a) =>
  a.addEventListener('click', () => document.body.classList.remove('menu-open'))
)

// Scroll reveal
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in')
        io.unobserve(e.target)
      }
    }
  },
  { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
)
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`
  io.observe(el)
})

// Lightbox
const lb = document.getElementById('lightbox')
const lbImg = document.getElementById('lightbox-img')
document.querySelectorAll('.gallery__item img').forEach((img) => {
  img.addEventListener('click', () => {
    lbImg.src = img.src
    lbImg.alt = img.alt
    lb.classList.add('open')
    lb.setAttribute('aria-hidden', 'false')
  })
})
const closeLb = () => {
  lb.classList.remove('open')
  lb.setAttribute('aria-hidden', 'true')
}
lb?.addEventListener('click', closeLb)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLb()
})
