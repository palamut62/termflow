# Release Rehberi

## GitHub Release ile Yayınlama

1. `package.json` içindeki `version` alanını yükselt.
2. Bir `GH_TOKEN` (repo yazma yetkili GitHub PAT) ortam değişkeni ayarla.
3. Şunu çalıştır:
   ```
   GH_TOKEN=xxxx npx electron-builder --publish always
   ```
4. electron-builder derlenen kurulum dosyalarını `palamut62/termflow` reposuna
   draft/release olarak yükler. `electron-builder.yml` içindeki `publish` bloğu
   bu repoyu hedefler.
5. Uygulama içi `autoUpdater` (bkz. `src/main/updater.ts`) sadece paketlenmiş
   build'de GitHub release'lerini kontrol eder ve indirir.

## Windows Kod İmzalama

İmzasız derlemeler Windows SmartScreen tarafından "Unrecognized publisher"
uyarısıyla engellenebilir/geciktirilebilir; kullanıcı "More info > Run anyway"
demek zorunda kalır. Bunu önlemek için iki seçenek:

- **Azure Trusted Signing** (önerilen, ucuz/bulut tabanlı): electron-builder'ın
  `win.signtoolOptions` alanına Azure Trusted Signing eklentisi ile entegre
  edilebilir. Detay: electron-builder dokümantasyonu "Azure Trusted Signing".
- **Klasik OV/EV sertifika**: `.pfx` dosyası ve şifresi ile ortam değişkenleri
  kullan: `CSC_LINK` (pfx dosya yolu/URL) ve `CSC_KEY_PASSWORD`. EV sertifikalar
  SmartScreen itibarını daha hızlı kazanır ama donanım token gerektirir.

## macOS Notarization

`mac.notarize` için Apple hesabı ortam değişkenleri gerekir:
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Bunlar ayarlıysa
electron-builder derleme sonrası otomatik notarize eder; aksi halde Gatekeeper
uygulamayı engelleyebilir.

## İmzasız Dağıtım Riski

İmza yoksa Windows SmartScreen ve macOS Gatekeeper kullanıcıya güven uyarısı
gösterir; bazı kurumsal ortamlarda çalıştırma tamamen engellenebilir. Mümkünse
en azından Windows tarafında Azure Trusted Signing kullanılması önerilir.
