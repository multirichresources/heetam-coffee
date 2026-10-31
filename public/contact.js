/* Maklumat hubungan HEETAMCOFF ROASTERY EMPIRE.
   Isi di sini sahaja; semua page (kedai, Refund Policy, Privacy Policy) akan guna nilai yang sama.
   Ruang yang kosong tidak dipaparkan. */
(function () {
  var CONTACT = {
    address: "Lot Cafe A, MARA Halal Industrial Park, Jalan Batu Caves, 68100 Batu Caves, Selangor",  /* contoh: "No. X, Jalan Y, 47000 Sungai Buloh, Selangor" */
    phone: "+60 13-922 6788",    /* contoh: "012-345 6789" */
    email: "heetamcoff.roastery@gmail.com"     /* contoh: "hello@heetamcoffroastery.com" */
  };
  var LABEL = { address: "Alamat: ", phone: "Tel / WhatsApp: ", email: "Emel: " };
  var els = document.querySelectorAll("[data-contact]");
  for (var i = 0; i < els.length; i++) {
    var key = els[i].getAttribute("data-contact");
    var val = CONTACT[key];
    if (!val) continue;
    els[i].textContent = (els[i].hasAttribute("data-nolabel") ? "" : LABEL[key]) + val;
    els[i].hidden = false;
  }
})();
