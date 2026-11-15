# Kontrak API admin GT06-Decode (`/api/admin/*`)

API ini dipanggil dari **sisi server** aplikasi lain (mis. GPS-Dashboard), tidak pernah dari browser
pengguna. Alamat dari jaringan Docker: `http://gt06-server:8080`.

Tidak ada perubahan pada `/api/external/*`.

## Autentikasi

Salah satu dari:

| Cara | Untuk | Catatan |
|---|---|---|
| `Authorization: Basic base64(ADMIN_USER:ADMIN_PASSWORD)` | manusia, curl, pembuatan token admin pertama | Tulis lintas-situs (header `Origin` ke host lain) ditolak `403` |
| `Authorization: Bearer <token scope admin>` | aplikasi (GPS-Dashboard) | Token dibuat dengan Basic Auth, disimpan di env server aplikasi |

- `ADMIN_PASSWORD` kosong di GT06-Decode => seluruh API ini `503` (termasuk token admin).
- Tanpa kredensial / salah => `401 {"error": "..."}`. Tantangan `WWW-Authenticate: Basic` hanya dikirim bila tidak ada header `Authorization`.
- Token `admin` **tidak** bisa: membuat token `admin`, menghapus token `admin`. Dua pembatasan ini mencegah token yang bocor memperluas aksesnya sendiri.
- Token `admin` tidak berlaku di `/api/external/*`, dan token `external` tidak berlaku di `/api/admin/*`.

Semua respons JSON `application/json`, `Cache-Control: no-store`. Error: `{"error": "pesan"}`; error server selalu `500 {"error": "Terjadi kesalahan internal server"}` (detail hanya di log server).

## Endpoint

### Info & device live
| Method | Path | Respons |
|---|---|---|
| GET | `/api/admin/info` | `{ "imeiEnforce": "off\|log\|on", "registry": { "mode", "loaded": bool, "count": n }, "devices": { "total": n, "online": n } }` |
| GET | `/api/admin/devices` | Array device live (memori), sama seperti `/api/external/devices` ditambah `registration`: `"registered" \| "disabled" \| "unregistered" \| "unknown"` |
| GET | `/api/admin/events` | SSE. Event: `log` `{ts, level, message}`, `device` (objek device), `clear` `{}`. Berisi log operasional (IP perangkat dsb.): hanya untuk admin |
| DELETE | `/api/admin/logs` | `204` mengosongkan histori log di server |
| POST | `/api/admin/reload-devices` | `{ "reloaded": n }` |

### Registry IMEI
Objek: `{ "imei": "352099001761481", "label": "Truk 01", "enabled": true, "createdAt": "ISO", "updatedAt": "ISO" }`

| Method | Path | Body | Respons |
|---|---|---|---|
| GET | `/api/admin/registry` | | `[objek]` terbaru dulu |
| POST | `/api/admin/registry` | `{ "imei", "label" }` | `201 objek`; `400` input tidak valid; `409` sudah terdaftar |
| PATCH | `/api/admin/registry/:imei` | `{ "label"? , "enabled"? }` (minimal satu) | `200 objek`; `400`; `404` |
| DELETE | `/api/admin/registry/:imei` | | `204`; `404` |
| POST | `/api/admin/registry/import-seen` | | `{ "imported": n }` mendaftarkan semua IMEI di tabel `devices` yang belum terdaftar (label "Belum diberi label") |

Validasi: `imei` string heksadesimal 1-20 karakter (praktiknya 15 digit; server menurunkan huruf besar), `label` 1-100 karakter setelah dipangkas, `enabled` harus boolean, body harus objek JSON.

Efek ke TCP (lihat `GT06_IMEI_ENFORCE` di README): mode `on` menolak LOGIN IMEI yang tidak terdaftar/nonaktif dan langsung memutus koneksi perangkat yang dihapus/dinonaktifkan.

### Token API
Objek: `{ "id", "label", "tokenPrefix", "scope": "external\|admin", "createdAt", "lastUsedAt" }`

| Method | Path | Body | Respons |
|---|---|---|---|
| GET | `/api/admin/tokens` | | `[objek]` |
| POST | `/api/admin/tokens` | `{ "label", "scope"?: "external"\|"admin" }` (default `external`) | `201 objek + "token"` (token mentah **hanya muncul di respons ini**); `403` bila token admin meminta scope `admin` |
| DELETE | `/api/admin/tokens/:id` | | `204`; `404`; `403` bila token admin menghapus token `admin` |

## Catatan untuk pemanggil
- Simpan token admin hanya di env server (mis. `GT06_ADMIN_TOKEN`), jangan kirim ke browser, jangan log.
- GT06-Decode **tidak** menyimpan plat nomor atau data kendaraan lain; itu milik aplikasi pemanggil, dikaitkan lewat IMEI.
- Format tanggal ISO 8601 UTC.
