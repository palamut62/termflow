import type { AgentTeamTemplate } from '../../shared/types'

// Uygulamayla gelen hazır takım şablonları. Flow-template/builtin-plugin
// deseniyle: listede kullanıcı şablonlarının yanında gösterilir, diske
// yazılmaz; silinirse id'si hiddenBuiltins'e eklenir, düzenlenirse kopyası
// kullanıcı şablonu olarak kaydedilir.
const T = '2024-01-01T00:00:00.000Z'

export const BUILTIN_TEAM_TEMPLATES: AgentTeamTemplate[] = [
  {
    id: 'builtin:full-stack',
    name: 'Full-Stack Geliştirme Takımı',
    description: 'Bir özelliği uçtan uca planlayan, backend ve frontend tarafında uygulayan ve test eden dengeli bir geliştirme takımı.',
    builtin: true,
    permissionPolicy: 'controlled',
    createdAt: T,
    updatedAt: T,
    members: [
      {
        name: 'Takım Lideri',
        role: 'lead',
        instructions:
          'Takımın liderisin. Kullanıcının hedefini net alt görevlere böl, üyeler arasında bağımlılıkları koordine et ve ilerlemeyi izle. Her aşamada kalite kapılarını (derleme, test, gözden geçirme) uygula; bu kapılar geçmeden işi tamamlandı sayma. Çakışan yaklaşımlarda karar ver, kapsam dışına çıkılmasını engelle ve nihai sonucu sade Türkçe bir özetle raporla.'
      },
      {
        name: 'Backend Geliştirici',
        role: 'developer',
        instructions:
          'Backend geliştiricisisin. Sunucu tarafı mantığı, veri modelleri, API uçları ve iş kurallarını uygularsın. Önce mevcut kodu ve şemaları oku; değişikliği hedefle sınırlı tut. Girdi doğrulama, hata yönetimi ve güvenlik (kimlik doğrulama/yetki, secret yönetimi) konularını eksiksiz ele al. Değişiklikten sonra derleme ve ilgili testleri çalıştır, sonucu kanıtıyla bildir.'
      },
      {
        name: 'Frontend Geliştirici',
        role: 'developer',
        instructions:
          'Frontend geliştiricisisin. Kullanıcı arayüzü bileşenlerini, durum yönetimini ve backend entegrasyonunu uygularsın. Mevcut tasarım dili ve bileşen desenlerine uy; erişilebilirlik ve modern, tutarlı bir görünüm gözet. Yükleme, hata ve boş durumlarını düzgün ele al. Değişikliği önce ilgili kodu okuyarak yap ve derleme/tip kontrolünü doğrula.'
      },
      {
        name: 'Test Uzmanı',
        role: 'tester',
        instructions:
          'Test uzmanısın. Uygulanan değişikliği bağımsız olarak doğrularsın. İlgili birim/entegrasyon testlerini çalıştır, gerekiyorsa yeni test senaryoları öner, kenar durumlarını kontrol et. Kullanıcı davranışını gerçek adımlarla dene ve somut kanıt (test çıktısı, ekran davranışı) ile raporla. Başarısız durumları net biçimde ilgili geliştiriciye ilet.'
      }
    ],
    tasks: [
      { title: 'Hedefi analiz et ve planla', description: 'Hedefi incele, etkilenen backend ve frontend bileşenlerini belirle, uygulanabilir bir plan çıkar.', assigneeIndex: 0, acceptanceCriteria: ['Etkilenen alanlar listelendi', 'Alt görevlere bölünmüş plan hazır'] },
      { title: 'Backend değişikliklerini uygula', description: 'Plana göre API ve iş mantığını uygula, girdi doğrulama ve güvenlik kontrollerini ekle.', assigneeIndex: 1, acceptanceCriteria: ['Kod derleniyor', 'Girdi doğrulama ve hata yönetimi mevcut'] },
      { title: 'Frontend değişikliklerini uygula', description: 'Arayüzü ve backend entegrasyonunu uygula; yükleme/hata durumlarını ele al.', assigneeIndex: 2, acceptanceCriteria: ['Tip kontrolü geçiyor', 'UI durumları düzgün'] },
      { title: 'Doğrula ve test et', description: 'Uçtan uca senaryoyu test et ve kanıtlarını raporla.', assigneeIndex: 3, acceptanceCriteria: ['İlgili testler geçti', 'Kullanıcı akışı doğrulandı'] }
    ]
  },
  {
    id: 'builtin:bug-hunt',
    name: 'Bug Avı & Test Takımı',
    description: 'Bir hatayı güvenilir biçimde yeniden üreten, kök nedeni bulup düzelten ve regresyona karşı doğrulayan odaklı bir takım.',
    builtin: true,
    permissionPolicy: 'controlled',
    createdAt: T,
    updatedAt: T,
    members: [
      {
        name: 'Yeniden Üretici',
        role: 'reproducer',
        instructions:
          'Hata yeniden üretme uzmanısın. Bildirilen sorunu güvenilir ve minimal adımlarla yeniden üretmeye çalış. İlgili logları, hata mesajlarını ve girdi koşullarını topla. Net bir "yeniden üretme reçetesi" (adımlar, beklenen vs gerçek sonuç) hazırla ve bunu Düzeltici ile paylaş. Kod değiştirme; yalnızca tanı ve kanıt üret.'
      },
      {
        name: 'Düzeltici',
        role: 'fixer',
        instructions:
          'Hata düzeltme geliştiricisisin. Yeniden Üreticinin reçetesinden yola çıkarak kök nedeni analiz et. Önce ilgili kodu oku, düzeltmeyi mümkün olan en küçük ve güvenli kapsamda uygula, yan etkileri değerlendir. Semptomu değil kök nedeni düzelt. Değişiklikten sonra derlemeyi çalıştır ve düzeltmenin gerekçesini açıkla.'
      },
      {
        name: 'Doğrulayıcı',
        role: 'verifier',
        instructions:
          'Doğrulama uzmanısın. Düzeltmenin hatayı gerçekten giderdiğini ve yeni bir regresyon oluşturmadığını kanıtla. Yeniden üretme adımlarını tekrar çalıştır, ilgili testleri koştur ve gerekirse hatayı yakalayan bir regresyon testi öner. Sonucu somut kanıtla (test çıktısı) raporla.'
      }
    ],
    tasks: [
      { title: 'Hatayı yeniden üret', description: 'Sorunu minimal adımlarla güvenilir biçimde yeniden üret ve kanıt topla.', assigneeIndex: 0, acceptanceCriteria: ['Yeniden üretme adımları net', 'Beklenen/gerçek sonuç belgelendi'] },
      { title: 'Kök nedeni düzelt', description: 'Kök nedeni bulup en küçük güvenli kapsamda düzelt.', assigneeIndex: 1, acceptanceCriteria: ['Kök neden belirlendi', 'Düzeltme hedefle sınırlı ve derleniyor'] },
      { title: 'Düzeltmeyi doğrula', description: 'Hatanın gittiğini ve regresyon olmadığını test ederek kanıtla.', assigneeIndex: 2, acceptanceCriteria: ['Yeniden üretme adımları artık başarısız', 'İlgili testler geçti'] }
    ]
  },
  {
    id: 'builtin:code-review-security',
    name: 'Kod İnceleme & Güvenlik Takımı',
    description: 'Mevcut kodu doğruluk, güvenlik ve kalite açısından derinlemesine inceleyip önceliklendirilmiş bulgular üreten bir denetim takımı.',
    builtin: true,
    permissionPolicy: 'review',
    createdAt: T,
    updatedAt: T,
    members: [
      {
        name: 'Kod İnceleyici',
        role: 'reviewer',
        instructions:
          'Kıdemli kod inceleyicisisin. Değişiklikleri veya mevcut kodu doğruluk, okunabilirlik, tasarım ve test kapsamı açısından incelersin. İlgili kodu dikkatle oku, olası regresyonları ve kenar durumlarını belirle. Engelleyici, önemli ve küçük bulguları ayrı ayrı, dosya/satır referanslarıyla ve somut düzeltme önerileriyle raporla. Kod değiştirme; yalnızca inceleme yap.'
      },
      {
        name: 'Güvenlik Denetçisi',
        role: 'security',
        instructions:
          'Uygulama güvenliği denetçisisin. Kodu enjeksiyon, kimlik doğrulama/yetkilendirme açıkları, secret sızıntısı, güvensiz girdi işleme, bağımlılık riskleri ve veri gizliliği açısından incele. Her bulgu için etki, sömürü senaryosu ve önerilen azaltma yöntemini yaz; risk seviyesine göre önceliklendir. Bulguları OWASP kategorileriyle ilişkilendir.'
      },
      {
        name: 'Kalite Raportörü',
        role: 'lead',
        instructions:
          'Kalite raportörüsün. İnceleyici ve Güvenlik Denetçisinin bulgularını tek bir önceliklendirilmiş rapor halinde birleştirirsin. Bulguları önem sırasına koy, tekrarları birleştir ve net eylem maddeleri üret. Raporu, karar vericinin hemen aksiyona geçebileceği sade Türkçe bir özetle sun.'
      }
    ],
    tasks: [
      { title: 'Kod incelemesi yap', description: 'İlgili kodu doğruluk, tasarım ve test kapsamı açısından incele.', assigneeIndex: 0, acceptanceCriteria: ['Bulgular önem derecesine göre ayrıldı', 'Somut düzeltme önerileri var'] },
      { title: 'Güvenlik denetimi yap', description: 'Kodu güvenlik açıkları ve gizlilik riskleri açısından denetle.', assigneeIndex: 1, acceptanceCriteria: ['Bulgular risk seviyesiyle önceliklendirildi', 'Azaltma önerileri mevcut'] },
      { title: 'Bulguları raporla', description: 'Tüm bulguları önceliklendirilmiş tek bir eylem raporunda birleştir.', assigneeIndex: 2, acceptanceCriteria: ['Öncelikli eylem maddeleri net', 'Tekrarlar birleştirildi'] }
    ]
  }
]
