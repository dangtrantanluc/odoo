/* ═══════════════════════════════════════════
   BBSW Attendance Check-in JS
   ═══════════════════════════════════════════ */

'use strict';

// ── State (seeded from server) ──
var acState = {
    isCheckedIn: AC_CHECKED_IN,
    checkinTime: AC_CHECKIN_TIME,   // "HH:MM"
    checkinTs: null,                // Date object of check-in
    todayRecords: AC_TODAY_RECORDS, // [{check_in, check_out, worked_hours, open}]
};

// ── DOM refs ──
var wrap        = document.getElementById('acWrap');
var clockEl     = document.getElementById('acClock');
var statusLabel = document.getElementById('acStatusLabel');
var statusSub   = document.getElementById('acStatusSub');
var elapsedEl   = document.getElementById('acElapsed');
var btn         = document.getElementById('acBtn');
var btnInner    = document.getElementById('acBtnInner');
var historyList = document.getElementById('acHistoryList');
var toastEl     = document.getElementById('acToast');
var checkinTimeEl = document.getElementById('acCheckinTime');

// ── Live clock ──
function updateClock() {
    var now = new Date();
    var h = String(now.getHours()).padStart(2, '0');
    var m = String(now.getMinutes()).padStart(2, '0');
    var s = String(now.getSeconds()).padStart(2, '0');
    if (clockEl) clockEl.textContent = h + ':' + m + ':' + s;
    updateElapsed();
}

function updateElapsed() {
    if (!elapsedEl) return;
    if (!acState.isCheckedIn || !acState.checkinTs) {
        elapsedEl.textContent = '';
        return;
    }
    var diff = Math.floor((Date.now() - acState.checkinTs) / 1000);
    if (diff < 0) diff = 0;
    var hh = Math.floor(diff / 3600);
    var mm = Math.floor((diff % 3600) / 60);
    var ss = diff % 60;
    elapsedEl.textContent = 'Đã làm: ' +
        String(hh).padStart(2, '0') + ':' +
        String(mm).padStart(2, '0') + ':' +
        String(ss).padStart(2, '0');
}

// Parse "HH:MM" to today's Date object (approximate, for elapsed timer)
function parseTimeToday(timeStr) {
    if (!timeStr) return null;
    var parts = timeStr.split(':');
    if (parts.length < 2) return null;
    var d = new Date();
    d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
    return d;
}

// ── Render UI based on state ──
function renderState() {
    if (!wrap) return;
    wrap.setAttribute('data-checked-in', acState.isCheckedIn ? 'true' : 'false');

    if (acState.isCheckedIn) {
        acState.checkinTs = parseTimeToday(acState.checkinTime);
        if (statusLabel) statusLabel.textContent = 'Đang làm việc';
        if (statusSub) statusSub.innerHTML = 'Vào ca lúc <strong id="acCheckinTime">' + acState.checkinTime + '</strong>';
        if (btnInner) btnInner.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:22px;height:22px">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>' +
            '</svg><span>RA CA</span>';

        // Update status icon
        var iconEl = wrap.querySelector('.ac-status-icon');
        if (iconEl) {
            iconEl.className = 'ac-status-icon ac-icon-in';
            iconEl.innerHTML =
                '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:30px;height:30px">' +
                '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>' +
                '</svg>';
        }
    } else {
        acState.checkinTs = null;
        if (statusLabel) statusLabel.textContent = 'Chưa vào ca';
        if (statusSub) statusSub.textContent = 'Bấm nút bên dưới để bắt đầu';
        if (elapsedEl) elapsedEl.textContent = '';
        if (btnInner) btnInner.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:22px;height:22px">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"/>' +
            '</svg><span>VÀO CA</span>';

        var iconEl2 = wrap.querySelector('.ac-status-icon');
        if (iconEl2) {
            iconEl2.className = 'ac-status-icon ac-icon-out';
            iconEl2.innerHTML =
                '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width:30px;height:30px">' +
                '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>' +
                '</svg>';
        }
    }

    renderHistory();
}

// ── History list ──
function renderHistory() {
    if (!historyList) return;
    var records = acState.todayRecords;
    if (!records || records.length === 0) {
        historyList.innerHTML = '<div class="ac-history-empty">Chưa có dữ liệu hôm nay</div>';
        return;
    }
    var html = '';
    records.forEach(function(r) {
        var dotClass = r.open ? 'dot-open' : 'dot-closed';
        var timeStr = r.check_in + (r.check_out ? ' → ' + r.check_out : ' → đang làm');
        var hoursStr = r.check_out ? (r.worked_hours + ' giờ') : '';
        html += '<div class="ac-history-row">' +
            '<span class="ac-history-dot ' + dotClass + '"></span>' +
            '<span class="ac-history-times">' + timeStr + '</span>' +
            '<span class="ac-history-hours">' + hoursStr + '</span>' +
            '</div>';
    });
    historyList.innerHTML = html;
}

// ── Toast ──
var _toastTimer = null;
function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function() {
        toastEl.classList.remove('show');
    }, 3000);
}

// ── GPS & Geofencing ──
var acGpsEl = document.getElementById('acGpsStatus');

// Tọa độ văn phòng & bán kính cho phép
// 90 Trần Thị Nghỉ, Phường Hạnh Thông, TP.HCM
var AC_OFFICE_LAT = 10.828814884905915;
var AC_OFFICE_LNG = 106.68254276692944;
var AC_MAX_RADIUS = 500; // mét

// Pending action khi cần chụp ảnh
var _pendingAction = null;
var _pendingGps = {};
var _capturedPhoto = null; // base64 string
var _videoStream = null;

function setGpsStatus(msg, cls) {
    if (!acGpsEl) return;
    acGpsEl.textContent = msg;
    acGpsEl.className = 'ac-gps-status ' + (cls || '');
}

// Công thức Haversine tính khoảng cách (mét)
function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Camera Modal ──
function openCameraModal(action, dist, gpsData) {
    _pendingAction = action;
    _pendingGps = gpsData || {};
    _capturedPhoto = null;

    var modal = document.getElementById('acCameraModal');
    var notice = document.getElementById('acCameraNotice');
    var video = document.getElementById('acVideo');
    var preview = document.getElementById('acPhotoPreview');
    var canvas = document.getElementById('acCanvas');
    var captureBtn = document.getElementById('acCaptureBtn');
    var retakeBtn = document.getElementById('acRetakeBtn');
    var submitBtn = document.getElementById('acSubmitPhotoBtn');

    if (!modal) return;

    // Reset UI
    if (preview) preview.style.display = 'none';
    if (video) video.style.display = 'block';
    if (captureBtn) captureBtn.style.display = 'block';
    if (retakeBtn) retakeBtn.style.display = 'none';
    if (submitBtn) submitBtn.style.display = 'none';
    if (notice) notice.textContent = '📍 Bạn đang cách VP ' + Math.round(dist) + 'm. Vui lòng chụp ảnh xác nhận.';

    modal.style.display = 'flex';

    // Mở camera
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
        .then(function(stream) {
            _videoStream = stream;
            if (video) {
                video.srcObject = stream;
                video.play();
            }
        })
        .catch(function(err) {
            closeCameraModal();
            showToast('⚠ Không mở được camera: ' + err.message);
        });
}

function closeCameraModal() {
    var modal = document.getElementById('acCameraModal');
    if (modal) modal.style.display = 'none';
    stopCamera();
    _pendingAction = null;
    _capturedPhoto = null;
    // Restore button
    if (btn) btn.disabled = false;
    renderState();
}

function stopCamera() {
    if (_videoStream) {
        _videoStream.getTracks().forEach(function(t) { t.stop(); });
        _videoStream = null;
    }
}

function capturePhoto() {
    var video = document.getElementById('acVideo');
    var canvas = document.getElementById('acCanvas');
    var preview = document.getElementById('acPhotoPreview');
    var captureBtn = document.getElementById('acCaptureBtn');
    var retakeBtn = document.getElementById('acRetakeBtn');
    var submitBtn = document.getElementById('acSubmitPhotoBtn');

    if (!video || !canvas) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    var ctx = canvas.getContext('2d');
    // Flip horizontally (selfie mirror effect)
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    var dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    // Extract base64 part only
    _capturedPhoto = dataUrl.split(',')[1];

    if (preview) {
        preview.src = dataUrl;
        preview.style.display = 'block';
    }
    if (video) video.style.display = 'none';
    if (captureBtn) captureBtn.style.display = 'none';
    if (retakeBtn) retakeBtn.style.display = 'inline-flex';
    if (submitBtn) submitBtn.style.display = 'inline-flex';

    stopCamera();
}

function retakePhoto() {
    var video = document.getElementById('acVideo');
    var preview = document.getElementById('acPhotoPreview');
    var captureBtn = document.getElementById('acCaptureBtn');
    var retakeBtn = document.getElementById('acRetakeBtn');
    var submitBtn = document.getElementById('acSubmitPhotoBtn');

    _capturedPhoto = null;
    if (preview) { preview.src = ''; preview.style.display = 'none'; }
    if (video) video.style.display = 'block';
    if (captureBtn) captureBtn.style.display = 'block';
    if (retakeBtn) retakeBtn.style.display = 'none';
    if (submitBtn) submitBtn.style.display = 'none';

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
        .then(function(stream) {
            _videoStream = stream;
            if (video) { video.srcObject = stream; video.play(); }
        });
}

function submitWithPhoto() {
    if (!_capturedPhoto || !_pendingAction) return;
    var submitBtn = document.getElementById('acSubmitPhotoBtn');
    if (submitBtn) submitBtn.disabled = true;

    var params = Object.assign({ photo: _capturedPhoto }, _pendingGps || {});
    callApi(_pendingAction, params, function(err, result) {
        closeCameraModal();
        if (err || (result && result.error)) {
            var msg = (result && result.error) || err;
            showToast('⚠ ' + msg);
            renderState();
            return;
        }
        handleApiResult(_pendingAction, result);
    });
}

function getGpsAndCall(action, callback) {
    if (!navigator.geolocation) {
        callback('Thiết bị không hỗ trợ GPS. Vui lòng dùng điện thoại.', null);
        return;
    }
    setGpsStatus('📡 Đang lấy vị trí...', 'loading');
    navigator.geolocation.getCurrentPosition(
        function(pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            var dist = haversine(lat, lng, AC_OFFICE_LAT, AC_OFFICE_LNG);
            var distRounded = Math.round(dist);

            if (dist > AC_MAX_RADIUS) {
                // Ngoài bán kính → mở camera
                setGpsStatus('📍 Cách VP ' + distRounded + 'm — cần chụp ảnh xác nhận', 'error');
                openCameraModal(action, dist, { latitude: lat, longitude: lng });
                return;
            }

            // Trong phạm vi → reverse geocode rồi chấm công
            setGpsStatus('✅ Trong phạm vi VP (' + distRounded + 'm)', 'loading');
            fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&accept-language=vi')
                .then(function(r) { return r.json(); })
                .then(function(geo) {
                    var addr = geo.display_name || (lat.toFixed(5) + ', ' + lng.toFixed(5));
                    setGpsStatus('📍 ' + distRounded + 'm · ' + addr, 'ok');
                    callApi(action, { latitude: lat, longitude: lng, address: addr }, callback);
                })
                .catch(function() {
                    setGpsStatus('📍 Trong phạm vi VP (' + distRounded + 'm)', 'ok');
                    callApi(action, { latitude: lat, longitude: lng }, callback);
                });
        },
        function(err) {
            var msg = 'Không lấy được vị trí';
            if (err.code === 1) msg = 'Bạn đã từ chối quyền vị trí. Vui lòng bật GPS.';
            if (err.code === 2) msg = 'Tín hiệu GPS yếu, thử lại.';
            if (err.code === 3) msg = 'Hết thời gian lấy GPS, thử lại.';
            setGpsStatus('🚫 ' + msg, 'error');
            callback(msg, null);
        },
        { timeout: 15000, maximumAge: 10000, enableHighAccuracy: true }
    );
}

// ── API call ──
function callApi(action, gpsData, callback) {
    var params = Object.assign({ action: action }, gpsData || {});
    fetch('/attendance/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            params: params,
        }),
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        if (data.result) {
            callback(null, data.result);
        } else if (data.error) {
            callback(data.error.message || 'Lỗi kết nối', null);
        } else {
            callback('Lỗi không xác định', null);
        }
    })
    .catch(function(err) {
        callback('Lỗi mạng: ' + err.message, null);
    });
}

// ── Handle API result (shared between normal flow and photo flow) ──
function handleApiResult(action, result) {
    if (action === 'in') {
        acState.isCheckedIn = true;
        acState.checkinTime = result.time || '';
        var toastMsg = '✅ Vào ca lúc ' + result.time;
        if (result.out_of_range) toastMsg += ' 📷 (đã xác nhận bằng ảnh)';
        else if (result.address) toastMsg += '\n📍 ' + result.address;
        showToast(toastMsg);
        acState.todayRecords.push({
            check_in: result.time,
            check_out: '',
            worked_hours: '',
            open: true,
        });
    } else {
        acState.isCheckedIn = false;
        acState.checkinTime = '';
        var toastMsg2 = '👋 Ra ca lúc ' + result.time + ' — Đã làm ' + result.worked_hours + ' giờ';
        if (result.out_of_range) toastMsg2 += ' 📷';
        showToast(toastMsg2);
        for (var i = acState.todayRecords.length - 1; i >= 0; i--) {
            if (acState.todayRecords[i].open) {
                acState.todayRecords[i].check_out = result.time;
                acState.todayRecords[i].worked_hours = result.worked_hours;
                acState.todayRecords[i].open = false;
                break;
            }
        }
    }
    renderState();
}

// ── Button handler ──
function acHandleClick() {
    if (!btn || btn.disabled) return;
    var action = acState.isCheckedIn ? 'out' : 'in';

    btn.disabled = true;
    if (btnInner) btnInner.innerHTML = '<span class="ac-spinner"></span><span>' +
        (action === 'in' ? 'Đang vào ca...' : 'Đang ra ca...') + '</span>';

    getGpsAndCall(action, function(err, result) {
        btn.disabled = false;

        if (err || (result && result.error)) {
            var msg = (result && result.error) || err;
            showToast('⚠ ' + msg);
            renderState();
            return;
        }

        handleApiResult(action, result);
    });
}

// ── Add to Home Screen (PWA) ──
var _deferredPrompt = null;

window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    _deferredPrompt = e;
    var banner = document.getElementById('acInstallBanner');
    if (banner && !localStorage.getItem('ac_install_dismissed')) {
        banner.style.display = 'block';
    }
});

document.addEventListener('DOMContentLoaded', function() {
    var installBtn   = document.getElementById('acInstallBtn');
    var installClose = document.getElementById('acInstallClose');
    var banner       = document.getElementById('acInstallBanner');

    if (installBtn) {
        installBtn.addEventListener('click', function() {
            if (_deferredPrompt) {
                _deferredPrompt.prompt();
                _deferredPrompt.userChoice.then(function() {
                    _deferredPrompt = null;
                    if (banner) banner.style.display = 'none';
                });
            } else {
                // iOS fallback: hướng dẫn thủ công
                showToast('iOS: Bấm nút Chia sẻ ⬆ → "Thêm vào màn hình chính"');
                if (banner) banner.style.display = 'none';
            }
        });
    }
    if (installClose) {
        installClose.addEventListener('click', function() {
            if (banner) banner.style.display = 'none';
            localStorage.setItem('ac_install_dismissed', '1');
        });
    }

    // iOS: show banner manually nếu chưa đứng standalone
    var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var isStandalone = window.navigator.standalone;
    if (isIos && !isStandalone && banner && !localStorage.getItem('ac_install_dismissed')) {
        banner.style.display = 'block';
        if (installBtn) installBtn.textContent = 'Hướng dẫn';
    }

    // Camera modal handlers
    var cameraClose = document.getElementById('acCameraClose');
    var captureBtn2 = document.getElementById('acCaptureBtn');
    var retakeBtn2 = document.getElementById('acRetakeBtn');
    var submitPhotoBtn = document.getElementById('acSubmitPhotoBtn');

    if (cameraClose) cameraClose.addEventListener('click', closeCameraModal);
    if (captureBtn2) captureBtn2.addEventListener('click', capturePhoto);
    if (retakeBtn2) retakeBtn2.addEventListener('click', retakePhoto);
    if (submitPhotoBtn) submitPhotoBtn.addEventListener('click', submitWithPhoto);

    // Seed checkin timestamp
    if (acState.isCheckedIn && acState.checkinTime) {
        acState.checkinTs = parseTimeToday(acState.checkinTime);
    }
    renderHistory();
    updateClock();
    setInterval(updateClock, 1000);
});
