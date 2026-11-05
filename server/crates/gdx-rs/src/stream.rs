// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
//! Port of `TMiBufferedStream` / `TBufferedFileStream` (`src/gdlib/gmsstrm.cpp`):
//! little/big endian detection from the 17 byte file prefix (`DetermineByteOrder`), short
//! strings (length byte + bytes) and the block compression used by GDX: each block is a
//! 3 byte header (`cxTyp`, big-endian 16 bit length) followed by that many bytes, zlib
//! (`compress`/`uncompress`) data when `cxTyp != 0`, raw bytes otherwise; a block holds at
//! most `BufferSize` (32 KiB) uncompressed bytes. Positions are physical file offsets.
use crate::error::{GdxError, Result};
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};
use std::io::{Read, Seek, SeekFrom, Write};

/// `BufferSize` in gmsstrm.hpp ("internal maximum for compression").
pub(crate) const BUFFER_SIZE: usize = 32 * 1024;
/// Read-ahead for uncompressed sections (any size works; larger is faster).
const READ_AHEAD: usize = 128 * 1024;

pub(crate) const PAT_WORD: u16 = 0x1234;
pub(crate) const PAT_INTEGER: i32 = 0x12345678;
/// `PAT_DOUBLE = 3.1415926535897932385` in gmsstrm.hpp (the same double as `PI`).
pub(crate) const PAT_DOUBLE: f64 = std::f64::consts::PI;

fn eof() -> GdxError {
    GdxError::corrupt("unexpected end of file")
}

/// Read until `buf` is full or EOF; returns the number of bytes read.
fn read_up_to<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(GdxError::io(&e)),
        }
    }
    Ok(n)
}

pub(crate) struct ReadStream<R> {
    inner: R,
    /// Physical position of `inner` (end of the data in `buf` when uncompressed).
    phys: u64,
    buf: Vec<u8>,
    loaded: usize,
    pos: usize,
    compress: bool,
    cbuf: Vec<u8>,
    inflate: Decompress,
    flip_word: bool,
    flip_int: bool,
    flip_double: bool,
}

impl<R: Read + Seek> ReadStream<R> {
    /// Open and run `DetermineByteOrder`; errors like `GoodByteOrder() != 0`.
    pub fn new(mut inner: R) -> Result<Self> {
        let phys = inner.stream_position().map_err(|e| GdxError::io(&e))?;
        let mut s = ReadStream {
            inner,
            phys,
            buf: vec![0; READ_AHEAD.max(u16::MAX as usize)],
            loaded: 0,
            pos: 0,
            compress: false,
            cbuf: vec![0; u16::MAX as usize],
            inflate: Decompress::new(true),
            flip_word: false,
            flip_int: false,
            flip_double: false,
        };
        let bad = || GdxError::new(crate::error::ERR_BADDATAFORMAT);
        // order_word / order_integer / order_double (initOrderCommon)
        let mut pat = |size: usize, expect: &[u8]| -> Result<bool> {
            let sz = s.read_u8().map_err(|_| bad())? as usize;
            if sz != size {
                return Err(bad());
            }
            let mut v = [0u8; 8];
            s.read_bytes(&mut v[..size]).map_err(|_| bad())?;
            if &v[..size] == expect {
                return Ok(false);
            }
            v[..size].reverse();
            if &v[..size] == expect {
                Ok(true)
            } else {
                Err(bad())
            }
        };
        let fw = pat(2, &PAT_WORD.to_le_bytes())?;
        let fi = pat(4, &PAT_INTEGER.to_le_bytes())?;
        let fd = pat(8, &PAT_DOUBLE.to_le_bytes())?;
        s.flip_word = fw;
        s.flip_int = fi;
        s.flip_double = fd;
        Ok(s)
    }

    /// `FillBuffer`; false at end of file.
    fn fill(&mut self) -> Result<bool> {
        self.pos = 0;
        self.loaded = 0;
        if !self.compress {
            let n = read_up_to(&mut self.inner, &mut self.buf[..READ_AHEAD])?;
            self.phys += n as u64;
            self.loaded = n;
        } else {
            let mut h = [0u8; 3];
            let n = read_up_to(&mut self.inner, &mut h)?;
            self.phys += n as u64;
            if n < 3 {
                return Ok(false);
            }
            let wlen = ((h[1] as usize) << 8) + h[2] as usize;
            if h[0] == 0 {
                if wlen > BUFFER_SIZE {
                    return Err(GdxError::corrupt("compressed stream block too large"));
                }
                let n = read_up_to(&mut self.inner, &mut self.buf[..wlen])?;
                self.phys += n as u64;
                self.loaded = n;
            } else {
                let n = read_up_to(&mut self.inner, &mut self.cbuf[..wlen])?;
                self.phys += n as u64;
                if n < wlen {
                    return Err(eof());
                }
                self.inflate.reset(true);
                let st = self
                    .inflate
                    .decompress(&self.cbuf[..wlen], &mut self.buf[..BUFFER_SIZE], FlushDecompress::Finish)
                    .map_err(|e| GdxError::corrupt(format!("zlib: {e}")))?;
                if st != Status::StreamEnd {
                    return Err(GdxError::corrupt("zlib: incomplete compressed block"));
                }
                self.loaded = self.inflate.total_out() as usize;
            }
        }
        Ok(self.loaded > 0)
    }

    pub fn set_compression(&mut self, v: bool) {
        if self.compress != v {
            self.loaded = 0;
            self.pos = 0;
        }
        self.compress = v;
    }

    pub fn set_position(&mut self, p: u64) -> Result<()> {
        if self.loaded > 0 && !self.compress {
            let start = self.phys - self.loaded as u64;
            if p >= start && p < self.phys {
                self.pos = (p - start) as usize;
                return Ok(());
            }
        }
        self.inner.seek(SeekFrom::Start(p)).map_err(|e| GdxError::io(&e))?;
        self.phys = p;
        self.loaded = 0;
        self.pos = 0;
        Ok(())
    }

    #[cold]
    fn read_bytes_slow(&mut self, out: &mut [u8]) -> Result<()> {
        let mut done = 0;
        while done < out.len() {
            if self.pos >= self.loaded && !self.fill()? {
                return Err(eof());
            }
            let k = (self.loaded - self.pos).min(out.len() - done);
            out[done..done + k].copy_from_slice(&self.buf[self.pos..self.pos + k]);
            self.pos += k;
            done += k;
        }
        Ok(())
    }

    #[inline]
    pub fn read_bytes(&mut self, out: &mut [u8]) -> Result<()> {
        if out.len() <= self.loaded - self.pos {
            out.copy_from_slice(&self.buf[self.pos..self.pos + out.len()]);
            self.pos += out.len();
            Ok(())
        } else {
            self.read_bytes_slow(out)
        }
    }

    #[inline]
    pub fn read_u8(&mut self) -> Result<u8> {
        if self.pos < self.loaded {
            let b = self.buf[self.pos];
            self.pos += 1;
            Ok(b)
        } else {
            let mut b = [0u8];
            self.read_bytes_slow(&mut b)?;
            Ok(b[0])
        }
    }

    #[inline]
    fn read_n<const N: usize>(&mut self, flip: bool) -> Result<[u8; N]> {
        let mut b = [0u8; N];
        self.read_bytes(&mut b)?;
        if flip {
            b.reverse();
        }
        Ok(b)
    }

    #[inline]
    pub fn read_u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.read_n::<2>(self.flip_word)?))
    }
    #[inline]
    pub fn read_i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.read_n::<4>(self.flip_int)?))
    }
    /// `ReadInt64` uses the integer byte order.
    pub fn read_i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.read_n::<8>(self.flip_int)?))
    }
    #[inline]
    pub fn read_f64(&mut self) -> Result<f64> {
        Ok(f64::from_le_bytes(self.read_n::<8>(self.flip_double)?))
    }

    /// `ReadString` / `ReadSString`: length byte then bytes.
    pub fn read_string(&mut self) -> Result<Vec<u8>> {
        let n = self.read_u8()? as usize;
        let mut v = vec![0u8; n];
        self.read_bytes(&mut v)?;
        Ok(v)
    }

    /// `ReadString` into a reusable buffer.
    pub fn read_string_into(&mut self, v: &mut Vec<u8>) -> Result<()> {
        let n = self.read_u8()? as usize;
        v.resize(n, 0);
        self.read_bytes(v)
    }
}

/// Writing side of `TBufferedFileStream` (always little endian, the native order of the
/// platforms GAMS supports; the prefix written by the `fmCreate` constructor records it).
pub(crate) struct WriteStream<W: Write + Seek> {
    inner: W,
    phys: u64,
    buf: Vec<u8>,
    compress: bool,
    deflate: Compress,
    cbuf: Vec<u8>,
    error: Option<GdxError>,
}

impl<W: Write + Seek> WriteStream<W> {
    pub fn new(inner: W) -> Self {
        let mut s = WriteStream {
            inner,
            phys: 0,
            buf: Vec::with_capacity(BUFFER_SIZE),
            compress: false,
            // `compress()` = zlib format at Z_DEFAULT_COMPRESSION (6)
            deflate: Compress::new(Compression::new(6), true),
            cbuf: vec![0; BUFFER_SIZE * 12 / 10 + 20],
            error: None,
        };
        s.write_u8(2);
        s.write_raw(&PAT_WORD.to_le_bytes());
        s.write_u8(4);
        s.write_raw(&PAT_INTEGER.to_le_bytes());
        s.write_u8(8);
        s.write_raw(&PAT_DOUBLE.to_le_bytes());
        s
    }

    fn put(&mut self, data: &[u8]) {
        if self.error.is_some() {
            return;
        }
        if let Err(e) = self.inner.write_all(data) {
            self.error = Some(GdxError::io(&e));
        }
        self.phys += data.len() as u64;
    }

    /// `FlushBuffer`.
    fn flush_buffer(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let data = std::mem::take(&mut self.buf);
        if !self.compress {
            self.put(&data);
        } else {
            self.deflate.reset();
            let ok = matches!(self.deflate.compress(&data, &mut self.cbuf, FlushCompress::Finish), Ok(Status::StreamEnd));
            let len = self.deflate.total_out() as usize;
            if ok && len < data.len() {
                let cb = std::mem::take(&mut self.cbuf);
                self.put(&[1, (len >> 8) as u8, (len & 0xff) as u8]);
                self.put(&cb[..len]);
                self.cbuf = cb;
            } else {
                let n = data.len();
                self.put(&[0, (n >> 8) as u8, (n & 0xff) as u8]);
                self.put(&data);
            }
        }
        self.buf = data;
        self.buf.clear();
    }

    pub fn write_raw(&mut self, mut data: &[u8]) {
        while !data.is_empty() {
            let k = (BUFFER_SIZE - self.buf.len()).min(data.len());
            self.buf.extend_from_slice(&data[..k]);
            data = &data[k..];
            if self.buf.len() >= BUFFER_SIZE {
                self.flush_buffer();
            }
        }
    }

    #[inline]
    pub fn write_u8(&mut self, b: u8) {
        if self.buf.len() + 1 < BUFFER_SIZE {
            self.buf.push(b);
        } else {
            self.write_raw(&[b]);
        }
    }
    pub fn write_u16(&mut self, v: u16) {
        self.write_raw(&v.to_le_bytes());
    }
    pub fn write_i32(&mut self, v: i32) {
        self.write_raw(&v.to_le_bytes());
    }
    pub fn write_i64(&mut self, v: i64) {
        self.write_raw(&v.to_le_bytes());
    }
    pub fn write_f64(&mut self, v: f64) {
        self.write_raw(&v.to_le_bytes());
    }
    /// `WriteString`: strings longer than 255 bytes are replaced by the library's error text
    /// (`strConvCppToDelphi`).
    pub fn write_string(&mut self, s: &[u8]) {
        const TOO_LONG: &[u8] = b"Error: Maximum short string length is 255 characters!";
        let s = if s.len() > 255 { TOO_LONG } else { s };
        self.write_u8(s.len() as u8);
        self.write_raw(s);
    }

    /// `GetPosition` (flushes a pending compressed block so positions are block starts).
    pub fn position(&mut self) -> u64 {
        if self.compress {
            self.flush_buffer();
        }
        self.phys + self.buf.len() as u64
    }

    pub fn set_position(&mut self, p: u64) {
        if !self.buf.is_empty() {
            if p == self.phys + self.buf.len() as u64 && !self.compress {
                return;
            }
            self.flush_buffer();
        }
        if self.error.is_none() {
            if let Err(e) = self.inner.seek(SeekFrom::Start(p)) {
                self.error = Some(GdxError::io(&e));
            }
        }
        self.phys = p;
    }

    pub fn set_compression(&mut self, v: bool) {
        if (self.compress || v) && !self.buf.is_empty() {
            self.flush_buffer();
        }
        self.compress = v;
    }

    /// Flush everything; the first I/O error, if any.
    pub fn finish(&mut self) -> Result<()> {
        self.flush_buffer();
        if self.error.is_none() {
            if let Err(e) = self.inner.flush() {
                self.error = Some(GdxError::io(&e));
            }
        }
        match self.error.take() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}
