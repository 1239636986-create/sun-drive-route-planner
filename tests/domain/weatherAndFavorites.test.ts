/**
 * 天气映射与收藏存储测试
 *
 * 天气映射是「安全相关」的：把「阴」误判成「晴」会导致阴天报警过多
 * （用户不再信任）；把「晴」误判成「雨」会导致漏报（真危险被抹掉）。
 * 因此每个等级都要钉死。
 */

import { describe, it, expect } from 'vitest';
import {
  weatherFactorFor,
  weatherFactorLabel,
  parseWeatherResponse,
  adcodeFromGeocode,
  adcodeFromRegeo,
  toYmd,
  pickCast,
  type WeatherCast,
} from '@/domain/weather.js';
import { parseFavorites, upsertFavorite, favoriteId, type FavoriteRoute } from '@/ui/useFavorites.js';
import { shorten } from '@/ui/components/Favorites.js';

describe('weatherFactorFor —— 天气文案到风险系数', () => {
  it.each([
    ['晴', 1.0],
    ['晴间多云', 0.85],
    ['少云', 0.85],
    ['多云', 0.55],
    ['阴', 0.25],
    ['小雨', 0.15],
    ['中雨', 0.15],
    ['雷阵雨', 0.15],
    ['小雪', 0.15],
    ['霾', 0.5],
    ['雾', 0.5],
  ])('%s -> %s', (text, expected) => {
    expect(weatherFactorFor(text)).toBeCloseTo(expected, 6);
  });

  it('降水优先级高于其他关键词（「雷阵雨」应判为降水而非阴）', () => {
    expect(weatherFactorFor('阴转雷阵雨')).toBe(0.15);
    expect(weatherFactorFor('多云有雨')).toBe(0.15);
  });

  it('关键词判定顺序正确 —— 更具体的文案不被更宽泛的子串截走', () => {
    // 这三个都因「子串包含」关系而对顺序敏感，是实际踩过的坑：
    //   「晴间多云」含「多云」→ 应先判 MOSTLY_CLEAR
    //   「阴转多云」含「多云」→ 应先判 OVERCAST
    //   「霾转多云」含「多云」→ 应先判霾
    expect(weatherFactorFor('晴间多云')).toBe(0.85);
    expect(weatherFactorFor('阴转多云')).toBe(0.25);
    expect(weatherFactorFor('霾转多云')).toBe(0.5);
    expect(weatherFactorFor('多云转晴')).toBe(0.55);
  });

  it('空文案保守取 1.0 —— 宁可多报不可漏报', () => {
    expect(weatherFactorFor('')).toBe(1.0);
    expect(weatherFactorFor('   ')).toBe(1.0);
  });

  it('未知文案保守取 1.0', () => {
    expect(weatherFactorFor('浮尘')).toBe(1.0);
    expect(weatherFactorFor('某某奇怪天气')).toBe(1.0);
  });

  it('系数恒在 (0, 1] 区间', () => {
    for (const t of ['晴', '多云', '阴', '暴雨', '霾', '', '未知']) {
      const f = weatherFactorFor(t);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('系数随遮蔽程度单调不增（晴 ≥ 少云 ≥ 多云 ≥ 阴 ≥ 雨）', () => {
    const seq = ['晴', '少云', '多云', '阴', '中雨'].map(weatherFactorFor);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!).toBeLessThanOrEqual(seq[i - 1]!);
    }
  });
});

describe('weatherFactorLabel', () => {
  it('每个系数区间都有可读说明', () => {
    for (const f of [1.0, 0.85, 0.55, 0.25, 0.5, 0.15]) {
      expect(weatherFactorLabel(f).length).toBeGreaterThan(0);
    }
  });

  it('晴天的说明体现「无衰减」', () => {
    expect(weatherFactorLabel(1.0)).toContain('无衰减');
  });

  it('雨雪的说明体现「几乎无直射光」', () => {
    expect(weatherFactorLabel(0.15)).toContain('几乎无直射光');
  });
});

describe('toYmd / pickCast', () => {
  it('格式化补零', () => {
    expect(toYmd(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toYmd(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('命中对应日期', () => {
    const casts: WeatherCast[] = [
      { date: '2026-10-12', dayWeather: '多云', nightWeather: '晴', dayTemp: '20', nightTemp: '12' },
      { date: '2026-10-13', dayWeather: '晴', nightWeather: '晴', dayTemp: '22', nightTemp: '13' },
    ];
    expect(pickCast(casts, '2026-10-13')?.dayWeather).toBe('晴');
  });

  it('超出预报范围时返回 null（而不是乱取一天）', () => {
    const casts: WeatherCast[] = [
      { date: '2026-10-12', dayWeather: '晴', nightWeather: '晴', dayTemp: '20', nightTemp: '12' },
    ];
    expect(pickCast(casts, '2026-11-01')).toBeNull();
  });
});

describe('parseWeatherResponse', () => {
  const payload = {
    status: '1',
    forecasts: [
      {
        city: '北京市',
        adcode: '110000',
        casts: [
          {
            date: '2026-10-12',
            week: '1',
            dayweather: '多云',
            nightweather: '晴',
            daytemp: '20',
            nighttemp: '12',
            daywind: '西南',
            daypower: '1-3',
          },
        ],
      },
    ],
  };

  it('白天出发取 dayweather', () => {
    const info = parseWeatherResponse(payload, '2026-10-12', 8);
    expect(info?.description).toBe('多云');
    expect(info?.factor).toBeCloseTo(0.55, 6);
    expect(info?.city).toBe('北京市');
  });

  it('夜间出发取 nightweather', () => {
    const info = parseWeatherResponse(payload, '2026-10-12', 21);
    expect(info?.description).toBe('晴');
    expect(info?.factor).toBeCloseTo(1.0, 6);
  });

  it('6:00 与 18:00 的昼夜边界', () => {
    expect(parseWeatherResponse(payload, '2026-10-12', 6)?.description).toBe('多云');
    expect(parseWeatherResponse(payload, '2026-10-12', 17)?.description).toBe('多云');
    expect(parseWeatherResponse(payload, '2026-10-12', 18)?.description).toBe('晴');
    expect(parseWeatherResponse(payload, '2026-10-12', 5)?.description).toBe('晴');
  });

  it('日期不在预报里返回 null', () => {
    expect(parseWeatherResponse(payload, '2027-01-01', 8)).toBeNull();
  });

  it('空载荷返回 null 而不抛错', () => {
    expect(parseWeatherResponse({}, '2026-10-12', 8)).toBeNull();
    expect(parseWeatherResponse({ forecasts: [] }, '2026-10-12', 8)).toBeNull();
    expect(parseWeatherResponse({ forecasts: [{ casts: [] }] }, '2026-10-12', 8)).toBeNull();
  });
});

describe('adcode 提取', () => {
  it('从地理编码结果取 adcode', () => {
    expect(adcodeFromGeocode([{ adcode: '120000' }])).toBe('120000');
  });

  it('从逆地理编码结果取 adcode', () => {
    expect(adcodeFromRegeo({ regeocode: { addressComponent: { adcode: '120114' } } })).toBe(
      '120114',
    );
  });

  it('缺失或类型错误时返回 null', () => {
    expect(adcodeFromGeocode([])).toBeNull();
    expect(adcodeFromGeocode(null)).toBeNull();
    expect(adcodeFromGeocode([{ adcode: 120000 }])).toBeNull();
    expect(adcodeFromRegeo({})).toBeNull();
    expect(adcodeFromRegeo(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('parseFavorites —— 损坏数据必须降级而非崩溃', () => {
  const valid: FavoriteRoute = {
    id: 'a->b',
    origin: { lon: 116.4, lat: 39.9, label: '北京' },
    destination: { lon: 117.2, lat: 39.1, label: '天津' },
    usedAt: 1,
  };

  it('null / 空串返回空列表', () => {
    expect(parseFavorites(null)).toEqual([]);
    expect(parseFavorites('')).toEqual([]);
  });

  it('非法 JSON 返回空列表', () => {
    expect(parseFavorites('{oops')).toEqual([]);
    expect(parseFavorites('not json at all')).toEqual([]);
  });

  it('结构不对返回空列表', () => {
    expect(parseFavorites('{}')).toEqual([]);
    expect(parseFavorites('[]')).toEqual([]);
    expect(parseFavorites('{"version":1}')).toEqual([]);
    expect(parseFavorites('{"items":"nope"}')).toEqual([]);
  });

  it('合法数据被读出', () => {
    const raw = JSON.stringify({ version: 1, items: [valid] });
    expect(parseFavorites(raw)).toEqual([valid]);
  });

  it('混入非法条目时只丢弃非法项', () => {
    const raw = JSON.stringify({
      version: 1,
      items: [
        valid,
        { id: 'x' }, // 缺字段
        { ...valid, id: 'c', origin: { lon: 'NaN', lat: 1, label: 'a' } }, // 类型错
        { ...valid, id: 'd', origin: { lon: 1, lat: 1, label: '' } }, // 空 label
      ],
    });
    const out = parseFavorites(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('a->b');
  });
});

describe('favoriteId / upsertFavorite', () => {
  it('同一组起终点生成相同 id', () => {
    const o = { lon: 116.4, lat: 39.9 };
    const d = { lon: 117.2, lat: 39.1 };
    expect(favoriteId(o, d)).toBe(favoriteId(o, d));
  });

  it('不同起终点生成不同 id', () => {
    const d = { lon: 117.2, lat: 39.1 };
    expect(favoriteId({ lon: 116.4, lat: 39.9 }, d)).not.toBe(
      favoriteId({ lon: 116.5, lat: 39.9 }, d),
    );
  });

  it('新增一条', () => {
    const out = upsertFavorite([], {
      id: 'a',
      origin: { lon: 1, lat: 1, label: 'A' },
      destination: { lon: 2, lat: 2, label: 'B' },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.usedAt).toBeGreaterThan(0);
  });

  it('重复保存同一 id 时更新而非新增，并置顶', () => {
    const base = upsertFavorite([], {
      id: 'a',
      origin: { lon: 1, lat: 1, label: 'A' },
      destination: { lon: 2, lat: 2, label: 'B' },
      usedAt: 100,
    });
    const withB = upsertFavorite(base, {
      id: 'b',
      origin: { lon: 3, lat: 3, label: 'C' },
      destination: { lon: 4, lat: 4, label: 'D' },
      usedAt: 200,
    });
    const reA = upsertFavorite(withB, {
      id: 'a',
      origin: { lon: 1, lat: 1, label: 'A' },
      destination: { lon: 2, lat: 2, label: 'B' },
      usedAt: 300,
    });

    expect(reA).toHaveLength(2);
    expect(reA[0]!.id).toBe('a');
    expect(reA[1]!.id).toBe('b');
  });

  it('按 usedAt 降序排列', () => {
    let list: FavoriteRoute[] = [];
    for (let i = 0; i < 5; i++) {
      list = upsertFavorite(list, {
        id: String(i),
        origin: { lon: i, lat: i, label: 'x' },
        destination: { lon: i, lat: i, label: 'y' },
        usedAt: i * 10,
      });
    }
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.usedAt).toBeGreaterThanOrEqual(list[i]!.usedAt);
    }
  });
});

describe('shorten', () => {
  it('短文本原样返回', () => {
    expect(shorten('北京')).toBe('北京');
  });

  it('长文本截断并加省略号', () => {
    const long = '北京市东城区东长安街天安门广场人民英雄纪念碑';
    const out = shorten(long, 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('恰好等于上限时不截断', () => {
    expect(shorten('1234567890', 10)).toBe('1234567890');
  });
});
