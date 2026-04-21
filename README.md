# Thought Agent (Obsidian Plugin)

Thought Agent, Obsidian icin gelistirilmis bir AI eklentisidir.
Notlarinla sohbet edebilir, bilgi grafini kullanarak baglam bulabilir ve yeni notlar olusturmaya yardimci olur.

## Ozellikler

- Obsidian notlariyla AI tabanli sohbet
- Vektor + BM25 + grafik tabanli hibrit arama altyapisi
- Excalidraw diyagramlarindan baglam cikarma
- Farkli LLM saglayicilarini destekleyen provider yapisi

## Proje Yapisi

- `src/agent`: ajan dongusu, oturum baglami, tool calistirma
- `src/retrieval`: indexleme, embedding, hibrit arama
- `src/excalidraw`: diyagram cikarma ve indexleme
- `src/views`: Obsidian UI panelleri
- `main.js`, `manifest.json`, `styles.css`: Obsidian plugin cikti/metadata dosyalari

## Gereksinimler

- Node.js 18+
- npm
- Obsidian (Desktop)

## Kurulum

```bash
npm install
```

## Gelistirme

```bash
npm run dev
```

## Build

```bash
npm run build
```

## GitHub'a Gonderme (Elle)

Asagidaki komutlari proje kokunde calistir:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<kullanici-adi>/<repo-adi>.git
git push -u origin main
```

Eger remote zaten varsa:

```bash
git remote set-url origin https://github.com/<kullanici-adi>/<repo-adi>.git
git push -u origin main
```

## Notlar

- `.gitignore` dosyasinda `vectors.json` ve `data.json` lokal uretilen veri olarak ignore edilir.
- Paket lisansi `MIT` olarak ayarlidir (`package.json`).
